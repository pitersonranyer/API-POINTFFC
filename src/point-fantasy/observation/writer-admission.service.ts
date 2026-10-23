import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ObservationError } from './official-normalizer';
import { retryObservationTransaction } from './observation-retry';
import { AdmissionRow, assertAdmissionGuards, WriterMode } from './writer-admission';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const localMaintenance = require('../../../scripts/point-fantasy-local-maintenance.cjs');

export interface AdmissionRequest {
  season: number; round: number; operationId: string; operator: string; reason: string;
  expectedMode: WriterMode | null; expectedGeneration: bigint; expectedRevision: bigint;
  expectedHash: string | null; expectedFence: bigint; target: WriterMode;
}
/** Isolated by default. Principal requires a verified, operation-bound maintenance capability. */
export class WriterAdmissionService {
  private readonly database: string;
  constructor(private readonly db: PrismaService, private readonly databaseUrl: string, private readonly localAuthorization?: object) {
    const url = new URL(databaseUrl); this.database = url.pathname.slice(1);
    if (localAuthorization) localMaintenance.destination(databaseUrl);
    else if (process.env.NODE_ENV === 'production' || url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1'
      || !/^point_fantasy_observation_3b2_test_\d+$/.test(this.database)) throw new ObservationError('ISOLATED_ADMISSION_REQUIRED');
  }
  private async execute(request: AdmissionRequest, action: 'INICIALIZAR' | 'TRANSICIONAR' | 'RECUPERAR') {
    const r = request;
    if (!Number.isInteger(r.season) || r.season < 2000 || r.season > 65535 || !Number.isInteger(r.round) || r.round < 1 || r.round > 38
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.operationId)
      || !r.operator.trim() || r.operator.length > 100 || !r.reason.trim() || r.reason.length > 1000
      || (r.expectedHash !== null && !/^[0-9a-f]{64}$/.test(r.expectedHash))
      || [r.expectedGeneration,r.expectedRevision,r.expectedFence].some(n => typeof n !== 'bigint' || n < 0n)
      || !['LEGADO','BLOQUEADO','ATUAL'].includes(r.target)) throw new ObservationError('INVALID_ADMISSION_REQUEST');
    if (this.localAuthorization) localMaintenance.assertScope(this.localAuthorization, this.databaseUrl, request, action);
    return retryObservationTransaction(() => this.db.$transaction(async tx => {
      if (this.localAuthorization) await localMaintenance.assertMaintenance(tx, this.localAuthorization, this.databaseUrl, request, action);
      const [database] = await tx.$queryRaw<Array<{ name: string }>>`SELECT DATABASE() AS name`;
      if (database.name !== this.database || process.env.NODE_ENV === 'production') throw new ObservationError('ISOLATED_ADMISSION_REQUIRED');
      await assertAdmissionGuards(tx);
      const [control] = await tx.$queryRaw<AdmissionRow[]>`SELECT MODO,GERACAO,ATUAL_JA_HABILITADO FROM FANTASY_ESCRITA_CONTROLE
        WHERE TEMPORADA=${r.season} AND RODADA=${r.round} FOR UPDATE`;
      if (action === 'INICIALIZAR') await tx.$executeRaw`INSERT INTO FANTASY_APURACAO_RODADA (TEMPORADA,RODADA,ATUALIZADO_EM)
        VALUES (${r.season},${r.round},UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE ID=ID`;
      const [round] = await tx.$queryRaw<Array<{ ID: number; REVISAO_ATUAL: bigint; HASH_CONTEUDO_ATUAL: string | null; FENCE: bigint; live: bigint; LOCK_TOKEN: string | null }>>`
        SELECT ID,REVISAO_ATUAL,HASH_CONTEUDO_ATUAL,FENCE,LOCK_TOKEN,IF(LOCK_ATE>UTC_TIMESTAMP(3),1,0) AS live
        FROM FANTASY_APURACAO_RODADA WHERE TEMPORADA=${r.season} AND RODADA=${r.round} FOR UPDATE`;
      const audit = { operacaoId: r.operationId, temporada: r.season, rodada: r.round, acao: action,
        origem: r.expectedMode, destino: r.target, geracaoBase: r.expectedGeneration, fenceBase: r.expectedFence,
        revisaoBase: r.expectedRevision, hashBase: r.expectedHash, operador: r.operator, justificativa: r.reason };
      const prior = await tx.fantasyEscritaTransicao.findUnique({ where: { operacaoId: r.operationId } });
      if (prior) {
        if (Object.entries(audit).some(([key,value]) => prior[key as keyof typeof prior] !== value)) throw new ObservationError('ADMISSION_OPERATION_CONFLICT');
        return { reused: true, mode: prior.destino, generation: prior.geracaoBase + (action === 'TRANSICIONAR' ? 1n : 0n) };
      }
      if (!round || round.REVISAO_ATUAL !== r.expectedRevision || round.HASH_CONTEUDO_ATUAL !== r.expectedHash || round.FENCE !== r.expectedFence
        || (control?.MODO ?? null) !== r.expectedMode || (control?.GERACAO ?? 0n) !== r.expectedGeneration) throw new ObservationError('ADMISSION_REFERENCE_CHANGED');
      if (action === 'INICIALIZAR' && (control || r.target !== 'LEGADO' || r.expectedMode !== null || r.expectedGeneration !== 0n)) throw new ObservationError('ADMISSION_INITIALIZATION_INVALID');
      if (action === 'TRANSICIONAR' && !((control?.MODO === 'LEGADO' && r.target === 'BLOQUEADO')
        || (control?.MODO === 'BLOQUEADO' && r.target === 'ATUAL') || (control?.MODO === 'ATUAL' && r.target === 'BLOQUEADO'))) throw new ObservationError('ADMISSION_TRANSITION_INVALID');
      if (action === 'RECUPERAR' && (control?.MODO !== 'BLOQUEADO' || r.target !== 'BLOQUEADO' || Number(round.live))) throw new ObservationError('ADMISSION_RECOVERY_BLOCKED');
      if (action === 'TRANSICIONAR' && r.target === 'ATUAL') {
        const pending = await tx.fantasyPontuacaoColeta.count({ where: { rodadaId: Number(round.ID), estado: 'EM_ANDAMENTO' } });
        const current = await tx.fantasyApuracaoRodada.findUniqueOrThrow({ where: { id: Number(round.ID) }, include: { ultimaColetaAplicada: true } });
        const legacy = await tx.fantasyPontuacaoColeta.findFirst({ where: { rodadaId: Number(round.ID), modeloPersistencia: 'SNAPSHOT_LEGADO', estado: 'SUCESSO' }, orderBy: { fence: 'desc' } });
        const pristine = current.revisaoAtual === 0n && !current.hashConteudoAtual && !legacy
          && await tx.fantasyPontuacaoAtleta.count({ where: { apuracaoId: Number(round.ID) } }) === 0
          && await tx.fantasyPontuacaoSnapshot.count({ where: { rodadaId: Number(round.ID) } }) === 0;
        if (round.LOCK_TOKEN !== null || pending || (!pristine && (current.revisaoAtual === 0n || !current.ultimaColetaAplicada))
          || (legacy && (!current.ultimaColetaAplicada || legacy.fence > current.ultimaColetaAplicada.fence))) throw new ObservationError('ADMISSION_NOT_QUIESCENT_OR_BACKFILLED');
      }
      await tx.fantasyEscritaTransicao.create({ data: audit });
      if (action === 'INICIALIZAR') {
        await tx.fantasyEscritaControle.create({ data: { temporada: r.season, rodada: r.round, modo: 'LEGADO', ultimaTransicaoId: r.operationId } });
      } else if (action === 'TRANSICIONAR') {
        await tx.fantasyEscritaControle.update({ where: { temporada_rodada: { temporada: r.season, rodada: r.round } }, data: {
          modo: r.target, geracao: { increment: 1 }, atualJaHabilitado: Boolean(control!.ATUAL_JA_HABILITADO) || r.target === 'ATUAL', ultimaTransicaoId: r.operationId } });
      } else {
        await tx.fantasyPontuacaoColeta.updateMany({ where: { rodadaId: Number(round.ID), estado: 'EM_ANDAMENTO' }, data: {
          estado: 'INTERROMPIDA', concluidaEm: new Date(), erroCodigo: 'ADMISSION_EXPIRED_RECOVERY' } });
        await tx.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_TOKEN=NULL,LOCK_ATE=NULL,FENCE=FENCE+1 WHERE ID=${round.ID}`;
      }
      return { reused: false, mode: r.target, generation: r.expectedGeneration + (action === 'TRANSICIONAR' ? 1n : 0n) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 }), true);
  }
  initialize(request: AdmissionRequest) { return this.execute(request, 'INICIALIZAR'); }
  transition(request: AdmissionRequest) { return this.execute(request, 'TRANSICIONAR'); }
  recoverExpired(request: AdmissionRequest) { return this.execute(request, 'RECUPERAR'); }
}
