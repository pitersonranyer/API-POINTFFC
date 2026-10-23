import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeOfficial, ObservationError, parseOfficialJson, sha256 } from './official-normalizer';
import { ObservationSource, SourceResponse } from './observation-source';
import { PersistenceStage, persistenceCode } from './observation-errors';
import { retryObservationTransaction } from './observation-retry';
import { assertWriterAdmission } from './writer-admission';

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export function market(response: SourceResponse) {
  if (response.status !== 200 || response.error || !response.text) return null;
  try {
    parseOfficialJson(response.text); // Reject duplicate contextual identity fields as well.
    const data = JSON.parse(response.text) as Record<string, unknown>;
    if (!data || !Number.isInteger(data.temporada) || !Number.isInteger(data.rodada_atual)
      || !Number.isInteger(data.status_mercado)) return null;
    return data;
  } catch { return null; }
}

export interface ObservationEvidence {
  before?: SourceResponse; after?: SourceResponse; matches?: SourceResponse; points?: SourceResponse;
}
export interface CurrentPersistenceContext extends ObservationEvidence {
  coletaId: number; rodadaId: number; temporada: number; rodada: number;
  normalized: ReturnType<typeof normalizeOfficial>;
  limitations: string[];
  stage: (value: PersistenceStage) => void;
}
export interface CurrentPersistenceResult {
  accepted: boolean;
  failure?: string;
  collection: Prisma.FantasyPontuacaoColetaUpdateManyMutationInput;
}

@Injectable()
export class ObservationService {
  private readonly logger = new Logger(ObservationService.name);
  constructor(protected readonly db: PrismaService, private readonly source: ObservationSource) {}
  protected readonly persistenceModel: 'SNAPSHOT_LEGADO' | 'ATUAL' = 'SNAPSHOT_LEGADO';
  protected async assertExecutionTarget(): Promise<void> { /* Legacy execution is unchanged. */ }
  protected async assertCollectionAuthorization(_tx: Tx, _season: number, _round: number, _operation: string, _acquiring = false): Promise<void> {}
  protected historicalIdentity(_season: number, _round: number, _before: SourceResponse, _after: SourceResponse, _points: SourceResponse, _normalized: ReturnType<typeof normalizeOfficial>): boolean | Promise<boolean> { return false; }
  protected async persistCurrent(_tx: Tx, _context: CurrentPersistenceContext): Promise<CurrentPersistenceResult> {
    throw new ObservationError('CURRENT_WRITER_NOT_CONFIGURED');
  }
  protected collectionEvidence({ before, after, matches, points }: ObservationEvidence): Prisma.FantasyPontuacaoColetaUpdateManyMutationInput {
    return { endpoint: points?.endpoint ?? '/atletas/pontuados',
      httpStatus: points?.status, payloadRecebido: points?.text,
      hashPayload: points?.text === null || points?.text === undefined ? undefined : sha256(points.text),
      statusAntes: before ? json(before) : Prisma.DbNull, statusDepois: after ? json(after) : Prisma.DbNull,
      evidenciasPartidas: matches ? json(matches) : Prisma.DbNull, cabecalhos: points ? json(points.headers) : Prisma.DbNull };
  }
  private failedApplication(): Prisma.FantasyPontuacaoColetaUpdateManyMutationInput {
    return this.persistenceModel === 'ATUAL' ? { resultadoAplicacao: 'REJEITADA', revisaoResultante: null } : {};
  }

  private async transaction<T>(action: (tx: Tx) => Promise<T>, retryUniqueConflict = false): Promise<T> {
    return retryObservationTransaction(() => this.db.$transaction(action,
      { isolationLevel: 'Serializable', timeout: 20000 }), retryUniqueConflict);
  }

  async collect(temporada: number, rodada: number, operacaoId: string = randomUUID()) {
    if (!Number.isInteger(temporada) || temporada < 2000 || temporada > 65535
      || !Number.isInteger(rodada) || rodada < 1 || rodada > 38
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operacaoId)) {
      throw new ObservationError('INVALID_PARAMETERS');
    }
    await this.assertExecutionTarget();
    const token = randomUUID();
    let admission: bigint | null = null;
    const start = await this.transaction(async tx => {
      await this.assertCollectionAuthorization(tx, temporada, rodada, operacaoId, true);
      admission = await assertWriterAdmission(tx, temporada, rodada, this.persistenceModel);
      // An empty Prisma upsert first reads under Serializable (shared lock), then upgrades
      // to FOR UPDATE. Competing acquisition/finalization can deadlock on that upgrade.
      // This atomic write takes the exclusive row lock first; an existing row is unchanged.
      await tx.$executeRaw`INSERT INTO FANTASY_APURACAO_RODADA (TEMPORADA, RODADA, ATUALIZADO_EM)
        VALUES (${temporada}, ${rodada}, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE ID=ID`;
      const [lockedRound] = await tx.$queryRaw<Array<{ id: bigint }>>`SELECT ID AS id FROM FANTASY_APURACAO_RODADA
        WHERE TEMPORADA=${temporada} AND RODADA=${rodada} FOR UPDATE`;
      // ID is INT UNSIGNED (exactly representable); no scoring decimal is converted.
      const round = { id: Number(lockedRound.id) };
      const previous = await tx.fantasyPontuacaoColeta.findUnique({ where: { operacaoId } });
      if (previous) {
        if (previous.rodadaId !== round.id) throw new ObservationError('OPERATION_CONFLICT');
        if ((previous.modeloPersistencia ?? 'SNAPSHOT_LEGADO') !== this.persistenceModel) throw new ObservationError('OPERATION_MODEL_CONFLICT');
        if (previous.estado === 'EM_ANDAMENTO') {
          const alive = await tx.$queryRaw<Array<{ alive: bigint }>>`SELECT COUNT(*) AS alive FROM FANTASY_APURACAO_RODADA
            WHERE ID=${round.id} AND LOCK_ATE > UTC_TIMESTAMP(3) AND FENCE=${previous.fence}`;
          if (Number(alive[0].alive) === 0) {
            const changed = await tx.fantasyPontuacaoColeta.updateMany({ where: { id: previous.id, estado: 'EM_ANDAMENTO', fence: previous.fence },
              data: { estado: 'INTERROMPIDA', concluidaEm: new Date(), erroCodigo: 'INTERRUPTED_OPERATION' } });
            if (changed.count !== 1) throw new ObservationError('TERMINAL_STATE_CONFLICT');
          }
        }
        return { id: previous.id, acquired: false, rodadaId: round.id, fence: 0n };
      }
      const row = await tx.fantasyPontuacaoColeta.create({ data: { operacaoId, rodadaId: round.id,
        ...(this.persistenceModel === 'ATUAL' ? { modeloPersistencia: 'ATUAL' } : {}), endpoint: '/atletas/pontuados' } });
      const acquired = await tx.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_TOKEN=${token},
        LOCK_ATE=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 120 SECOND), FENCE=FENCE+1, ATUALIZADO_EM=UTC_TIMESTAMP(3)
        WHERE ID=${round.id} AND (LOCK_ATE IS NULL OR LOCK_ATE <= UTC_TIMESTAMP(3))`;
      if (!acquired) {
        await tx.fantasyPontuacaoColeta.update({ where: { id: row.id }, data: {
          estado: 'LEASE_OCUPADO', concluidaEm: new Date(), erroCodigo: 'ROUND_BUSY' } });
        return { id: row.id, acquired: false, rodadaId: round.id, fence: 0n };
      }
      const current = await tx.fantasyApuracaoRodada.findUniqueOrThrow({ where: { id: round.id } });
      await tx.fantasyPontuacaoColeta.updateMany({ where: { rodadaId: round.id, estado: 'EM_ANDAMENTO', id: { not: row.id }, fence: { lt: current.fence } },
        data: { estado: 'INTERROMPIDA', concluidaEm: new Date(), erroCodigo: 'INTERRUPTED_OPERATION' } });
      await tx.fantasyPontuacaoColeta.update({ where: { id: row.id }, data: { fence: current.fence } });
      return { id: row.id, acquired: true, rodadaId: round.id, fence: current.fence };
    }, true).catch(error => { throw new ObservationError(persistenceCode(error, 'LEASE_ACQUIRE')); });
    if (!start.acquired) return this.summary(start.id);

    let before: SourceResponse | undefined, after: SourceResponse | undefined, matches: SourceResponse | undefined;
    let points: SourceResponse | undefined;
    let normalized: ReturnType<typeof normalizeOfficial> | undefined;
    let failure: string | undefined;
    let identityPending = false;
    const limitations = ['OBSERVATION_ONLY', 'PROVIDER_HTTP_CACHE_POSSIBLE', 'FINAL_COMPLETENESS_NOT_PROVEN'];
    try {
      before = await this.source.get('/mercado/status');
      const context = market(before);
      // Historical route only for earlier rounds. Never pretend /N is interchangeable with current.
      const endpoint = context && (temporada < Number(context.temporada)
        || temporada === context.temporada && rodada < Number(context.rodada_atual))
        ? `/atletas/pontuados/${rodada}` : '/atletas/pontuados';
      points = await this.source.get(endpoint);
      matches = await this.source.get(`/partidas/${rodada}`);
      after = await this.source.get('/mercado/status');
      const latest = market(after);
      if (points.error) throw new ObservationError(points.error);
      if (points.status !== 200 || points.text === null) throw new ObservationError('INVALID_RESPONSE');
      normalized = normalizeOfficial(points.text, temporada, rodada);
      const currentIdentity = context && latest && context.temporada === temporada && latest.temporada === temporada
        && context.rodada_atual === rodada && latest.rodada_atual === rodada
        && context.status_mercado === latest.status_mercado;
      // The current writer may accept explicit historical payload identity; legacy stays unchanged.
      if (!currentIdentity && !await this.historicalIdentity(temporada, rodada, before, after, points, normalized)) {
        identityPending = true; normalized = undefined; failure = 'SEASON_IDENTITY_UNPROVEN';
        limitations.push('REQUESTED_IDENTITY_ONLY_NO_SNAPSHOT');
      }
      if (matches.error) limitations.push('MATCH_EVIDENCE_UNAVAILABLE');
    } catch (error) {
      failure = error instanceof ObservationError ? error.code : 'OBSERVATION_INTERNAL_ERROR';
      normalized = undefined;
    }

    let stage: PersistenceStage = 'COLLECTION_ASSOCIATE';
    const evidence = () => this.collectionEvidence({ before, after, matches, points });
    try {
      await this.transaction(async tx => {
        stage = 'COLLECTION_ASSOCIATE';
        await this.assertCollectionAuthorization(tx, temporada, rodada, operacaoId);
        await assertWriterAdmission(tx, temporada, rodada, this.persistenceModel, admission);
        await tx.$queryRaw`SELECT ID FROM FANTASY_APURACAO_RODADA WHERE ID=${start.rodadaId} FOR UPDATE`;
        const operation = await tx.fantasyPontuacaoColeta.findUniqueOrThrow({ where: { id: start.id } });
        if (operation.estado !== 'EM_ANDAMENTO') {
          this.logger.warn({ code: 'LATE_COMPLETION_DISCARDED', coletaId: start.id });
          return; // Existing terminal result and evidence are immutable.
        }
        const live = await tx.$queryRaw<Array<{ alive: bigint }>>`SELECT COUNT(*) AS alive FROM FANTASY_APURACAO_RODADA
          WHERE ID=${start.rodadaId} AND LOCK_TOKEN=${token} AND FENCE=${start.fence} AND LOCK_ATE > UTC_TIMESTAMP(3)`;
        const owned = Number(live[0].alive) === 1;
        if (!owned) throw new ObservationError('AUTHORIZATION_LOST');
        const transactionLimitations = [...limitations];
        let snapshotId: number | undefined;
        let current: CurrentPersistenceResult | undefined;
        if (normalized && this.persistenceModel === 'ATUAL') {
          current = await this.persistCurrent(tx, { coletaId: start.id, rodadaId: start.rodadaId, temporada, rodada,
            normalized, before, after, matches, points, limitations: transactionLimitations, stage: value => { stage = value; } });
        }
        if (this.persistenceModel === 'SNAPSHOT_LEGADO' && owned && normalized && points?.text !== null && points?.text !== undefined) {
          const known = await tx.fantasyPontuacaoSnapshot.findUnique({ where: { rodadaId_versaoNormalizador_hashConteudo: {
            rodadaId: start.rodadaId, versaoNormalizador: normalized.version, hashConteudo: normalized.hashConteudo } } });
          if (known) { snapshotId = known.id; transactionLimitations.push('SNAPSHOT_REUSED'); }
          else {
            stage = 'SNAPSHOT_INSERT';
            const round = await tx.fantasyApuracaoRodada.update({ where: { id: start.rodadaId }, data: { ultimaVersaoSnapshot: { increment: 1 } } });
            const snapshot = await tx.fantasyPontuacaoSnapshot.create({ data: { rodadaId: start.rodadaId,
              versao: round.ultimaVersaoSnapshot, hashConteudo: normalized.hashConteudo, versaoNormalizador: normalized.version,
              fonte: 'CARTOLA_PONTUADOS', endpointOrigem: points.endpoint, payloadOriginal: points.text,
              hashPayload: normalized.hashPayload, coletadoEm: new Date(points.receivedAt) } });
            for (let offset = 0; offset < normalized.athletes.length; offset += 100) {
              stage = 'ATHLETE_BATCH';
              await tx.fantasyPontuacaoAtletaSnapshot.createMany({ data: normalized.athletes.slice(offset, offset + 100).map(a => {
                const { canonical, scouts, ...data } = a;
                void canonical; // Hash-only representation is not a database column.
                return { ...data, snapshotId: snapshot.id, scouts: scouts === null ? Prisma.DbNull : scouts };
              }) });
            }
            snapshotId = snapshot.id;
            transactionLimitations.push('SNAPSHOT_CREATED');
          }
        }
        const code = current?.failure ?? failure;
        const state = snapshotId || current?.accepted ? 'SUCESSO' : identityPending ? 'IDENTIDADE_PENDENTE'
          : code?.startsWith('HTTP_') ? 'FALHA_HTTP' : ['PROVIDER_TIMEOUT', 'PROVIDER_NETWORK'].includes(code ?? '') ? 'FALHA_REDE' : 'RESPOSTA_INVALIDA';
        stage = 'COLLECTION_ASSOCIATE';
        const changed = await tx.fantasyPontuacaoColeta.updateMany({ where: { id: start.id, fence: start.fence,
          estado: 'EM_ANDAMENTO' }, data: { ...evidence(), ...this.failedApplication(), snapshotId, estado: state, concluidaEm: new Date(),
          limitacoes: json(transactionLimitations), erroCodigo: code ?? null, ...current?.collection } });
        if (changed.count !== 1) throw new ObservationError('TERMINAL_STATE_CONFLICT');
        stage = 'FINAL_AUTHORIZE';
        // Linearization point: last SQL statement, fresh MySQL statement clock (not transaction-start time).
        // Failure rolls back snapshot, all athlete batches, counter and collection association together.
        const authorized = await tx.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_TOKEN=NULL, LOCK_ATE=NULL,
          ULTIMO_ERRO_CODIGO=${code ?? null}, ATUALIZADO_EM=UTC_TIMESTAMP(3)
          WHERE ID=${start.rodadaId} AND LOCK_TOKEN=${token} AND FENCE=${start.fence} AND LOCK_ATE > UTC_TIMESTAMP(3)`;
        if (authorized !== 1) throw new ObservationError('AUTHORIZATION_LOST');
        stage = 'COMMIT';
      });
    } catch (error) {
      const code = persistenceCode(error, stage);
      // A revoked admission cannot modify even its previous collection in recovery.
      if (code.startsWith('ADMISSION_')) throw new ObservationError(code);
      this.logger.warn({ code, coletaId: start.id });
      try {
        await this.transaction(async tx => {
          await this.assertCollectionAuthorization(tx, temporada, rodada, operacaoId);
          await assertWriterAdmission(tx, temporada, rodada, this.persistenceModel, admission);
          await tx.$queryRaw`SELECT ID FROM FANTASY_APURACAO_RODADA WHERE ID=${start.rodadaId} FOR UPDATE`;
          // A committed terminal result wins even if the client lost the commit acknowledgement.
          const row = await tx.fantasyPontuacaoColeta.findUniqueOrThrow({ where: { id: start.id } });
          if (row.estado !== 'EM_ANDAMENTO') return;
          const changed = await tx.fantasyPontuacaoColeta.updateMany({ where: { id: start.id, fence: start.fence, estado: 'EM_ANDAMENTO' },
            data: { ...evidence(), ...this.failedApplication(), estado: code === 'AUTHORIZATION_LOST' ? 'INTERROMPIDA' : 'RESPOSTA_INVALIDA',
              concluidaEm: new Date(), erroCodigo: code, limitacoes: json([...limitations, 'PERSISTENCE_ATTEMPT_FAILED']) } });
          if (changed.count !== 1) throw new ObservationError('TERMINAL_STATE_CONFLICT');
          await tx.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_TOKEN=NULL, LOCK_ATE=NULL,
            ULTIMO_ERRO_CODIGO=${code}, ATUALIZADO_EM=UTC_TIMESTAMP(3)
            WHERE ID=${start.rodadaId} AND LOCK_TOKEN=${token} AND FENCE=${start.fence}`;
        });
      } catch {
        this.logger.warn({ code: 'DB_RECOVERY_FAILED', originalCode: code, coletaId: start.id });
        throw new ObservationError(code);
      }
    }
    return this.summary(start.id);
  }

  private async summary(id: number) {
    const row = await this.db.fantasyPontuacaoColeta.findUniqueOrThrow({ where: { id },
      include: { snapshot: { include: { _count: { select: { atletas: true } } } } } });
    const coaches = row.snapshotId ? await this.db.fantasyPontuacaoAtletaSnapshot.count({ where: { snapshotId: row.snapshotId, posicaoId: 6 } }) : 0;
    return { coletaId: row.id, operacaoId: row.operacaoId, estado: row.estado, snapshotId: row.snapshotId,
      versao: row.snapshot?.versao ?? null, hash: row.snapshot?.hashConteudo.slice(0, 12) ?? null,
      atletas: row.qtdRecebidos ?? row.snapshot?._count.atletas ?? 0,
      tecnicos: this.persistenceModel === 'ATUAL' ? null : coaches, erroCodigo: row.erroCodigo,
      modeloPersistencia: row.modeloPersistencia ?? 'SNAPSHOT_LEGADO',
      revisaoBase: row.revisaoBase?.toString() ?? null, revisaoResultante: row.revisaoResultante?.toString() ?? null,
      resultadoAplicacao: row.resultadoAplicacao ?? null,
      inseridos: row.qtdInseridos ?? 0, alterados: row.qtdAlterados ?? 0, omitidos: row.qtdOmitidos ?? 0,
      limitacoes: row.limitacoes, snapshotCriadoNestaColeta: Array.isArray(row.limitacoes) && row.limitacoes.includes('SNAPSHOT_CREATED') };
  }
}
