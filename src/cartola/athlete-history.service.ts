import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AthleteHistoryQueryDto } from './dto/athlete-history-query.dto';
import { AthleteHistoryResponseDto, AthleteHistoryRoundDto } from './dto/athlete-history-response.dto';
import { athleteHistoryMetrics } from './athlete-history.metrics';

const snapshotSelect = { rodada: true, status: true, pontuados: true, consolidadoEm: true } as const;
type Snapshot = Prisma.RodadaProcessamentoGetPayload<{ select: typeof snapshotSelect }>;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

@Injectable()
export class AthleteHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async getHistory(atletaId: number, query: AthleteHistoryQueryDto): Promise<AthleteHistoryResponseDto> {
    let reference = query.rodadaReferencia;
    if (reference === undefined) {
      const latest = await this.prisma.rodadaProcessamento.findFirst({
        where: { temporada: query.temporada, status: 'CONSOLIDADA', rodada: { gte: 1, lte: 38 } },
        orderBy: { rodada: 'desc' }, select: { rodada: true },
      });
      if (!latest) throw new NotFoundException('Nenhuma rodada consolidada para a temporada informada');
      reference = latest.rodada;
    }
    const snapshots = await this.prisma.rodadaProcessamento.findMany({
      where: { temporada: query.temporada, rodada: { gte: 1, lte: reference } },
      select: snapshotSelect, orderBy: { rodada: 'asc' },
    });
    const byRound = new Map(snapshots.map(s => [s.rodada, s]));
    const rounds = Array.from({ length: reference }, (_, i) => this.project(i + 1, byRound.get(i + 1), atletaId, query.temporada));
    const samples = rounds.filter(r => r.statusRodada === 'CONSOLIDADA' && r.estadoSnapshot === 'VALIDO' && r.pontuacao !== null)
      .map(r => ({ rodada: r.rodada, pontuacao: r.pontuacao! }));
    return {
      atletaId, temporada: query.temporada, rodadaReferencia: reference,
      historico: rounds.slice(Math.max(0, reference - (query.limite ?? 5))),
      indicadores: athleteHistoryMetrics(samples, reference),
      cobertura: {
        rodadasSemSnapshot: rounds.filter(r => r.estadoSnapshot === 'AUSENTE' || r.estadoSnapshot === 'SEM_JSON').map(r => r.rodada),
        rodadasSemPontuacaoDoAtleta: rounds.filter(r => r.pontuacao === null).map(r => r.rodada),
        rodadasParciais: rounds.filter(r => r.parcial).map(r => r.rodada),
        rodadasComSnapshotInvalidoOuIncompleto: rounds.filter(r => r.estadoSnapshot === 'INVALIDO' || r.estadoSnapshot === 'INCOMPLETO').map(r => r.rodada),
        temporadaComSnapshotsCompletosAteReferencia: rounds.every(r => r.estadoSnapshot === 'VALIDO' && r.statusRodada === 'CONSOLIDADA'),
      },
    };
  }

  private project(rodada: number, snapshot: Snapshot | undefined, atletaId: number, temporada: number): AthleteHistoryRoundDto {
    const result: AthleteHistoryRoundDto = {
      rodada, statusRodada: snapshot?.status ?? null, situacao: 'SEM_DADOS', motivo: null,
      pontuacao: null, entrouEmCampo: null, scouts: null,
      consolidadoEm: snapshot?.consolidadoEm?.toISOString() ?? null,
      estadoSnapshot: 'AUSENTE', parcial: snapshot !== undefined && snapshot.status !== 'CONSOLIDADA',
    };
    if (!snapshot) return { ...result, motivo: 'RODADA_SEM_REGISTRO' };
    if (snapshot.pontuados === null) return { ...result, estadoSnapshot: 'SEM_JSON', motivo: 'SNAPSHOT_SEM_PONTUADOS' };
    const payload: unknown = snapshot.pontuados;
    if (!record(payload) || payload.rodada !== rodada || (payload.temporada !== undefined && payload.temporada !== temporada)) {
      return { ...result, estadoSnapshot: 'INVALIDO', situacao: 'DADO_INVALIDO', motivo: 'ENVELOPE_INVALIDO' };
    }
    if (payload.atletas === undefined || payload.atletas === null) {
      return { ...result, estadoSnapshot: 'INCOMPLETO', motivo: 'ENVELOPE_SEM_ATLETAS' };
    }
    if (!record(payload.atletas)) return { ...result, estadoSnapshot: 'INVALIDO', situacao: 'DADO_INVALIDO', motivo: 'ATLETAS_INVALIDOS' };
    result.estadoSnapshot = 'VALIDO';
    const envelopeIssues: string[] = [];
    if (Object.keys(payload.atletas).length === 0) envelopeIssues.push('ENVELOPE_SEM_PONTUADOS');
    if (payload.total_atletas !== undefined && (!Number.isInteger(payload.total_atletas)
      || payload.total_atletas !== Object.keys(payload.atletas).length)) envelopeIssues.push('TOTAL_ATLETAS_DIVERGENTE');
    if (envelopeIssues.length) result.estadoSnapshot = 'INCOMPLETO';
    if (!Object.prototype.hasOwnProperty.call(payload.atletas, String(atletaId))) {
      return { ...result, motivo: [...envelopeIssues, 'ATLETA_AUSENTE_NO_SNAPSHOT'].join(';') };
    }
    const athlete = payload.atletas[String(atletaId)];
    if (!record(athlete)) return { ...result, situacao: 'DADO_INVALIDO', motivo: 'ATLETA_INVALIDO' };
    const issues: string[] = [...envelopeIssues];
    if (typeof athlete.entrou_em_campo === 'boolean') result.entrouEmCampo = athlete.entrou_em_campo;
    else if (athlete.entrou_em_campo !== undefined) issues.push('PARTICIPACAO_INVALIDA');
    if (athlete.scout !== undefined && athlete.scout !== null) {
      if (record(athlete.scout) && Object.values(athlete.scout).every(finite)) result.scouts = { ...athlete.scout } as Record<string, number>;
      else issues.push('SCOUTS_INVALIDOS');
    }
    if (finite(athlete.pontuacao)) {
      result.pontuacao = athlete.pontuacao;
      result.situacao = 'PONTUADO';
    } else if (athlete.pontuacao !== undefined && athlete.pontuacao !== null) {
      result.situacao = 'DADO_INVALIDO'; issues.push('PONTUACAO_INVALIDA');
    } else if (result.entrouEmCampo === false) {
      result.situacao = 'NAO_JOGOU'; issues.push('NAO_JOGOU_CONFIRMADO');
    } else issues.push('PONTUACAO_AUSENTE');
    result.motivo = issues.length ? issues.join(';') : null;
    return result;
  }
}
