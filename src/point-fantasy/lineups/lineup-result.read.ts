import { FantasyCatalogoAtleta, FantasyCompeticao, FantasyEscalacao, FantasyEscalacaoPapel, Prisma } from '@prisma/client';
import { rankScores } from '../scoring/scoring-engine';
import { isCurrentResult } from '../scoring/result-readiness';
import { LineupResultDetailDto, LineupResultSummaryDto, ParticipationOrigin } from './lineup-result.dto';

type Scope = Pick<FantasyCompeticao, 'id' | 'temporada' | 'rodada' | 'fechamentoDefinitivoEm'>;
type Lineup = Pick<FantasyEscalacao, 'id' | 'versao' | 'capitaoAtletaId' | 'reservaMagoAtletaId'> & {
  atletas: { catalogoAtletaId: number; papel: FantasyEscalacaoPapel; atleta: FantasyCatalogoAtleta }[];
};
const metadata = { competicaoId: true, temporada: true, rodada: true, revisao: true, hashFonte: true,
  versaoEscalacao: true, versaoMotor: true, total: true, atualizadoEm: true } as const;

/** Two batched reads, regardless of page size. Ranks use all enrolled teams,
 * with the same completeness rule as the existing public ranking. */
export async function readResultSummaries(tx: Prisma.TransactionClient, competition: Scope) {
  const summaries = new Map<number, LineupResultSummaryDto>();
  const round = await tx.fantasyApuracaoRodada.findUnique({ where: { temporada_rodada: {
    temporada: competition.temporada, rodada: competition.rodada,
  } }, select: { id: true, revisaoAtual: true, hashConteudoAtual: true } });
  if (!round) return { summaries, round };
  const entries = await tx.fantasyEscalacao.findMany({ where: { competicaoId: competition.id, status: 'INSCRITA' },
    select: { id: true, versao: true, resultado: { select: metadata } }, orderBy: { id: 'asc' } });
  const ranked = rankScores(entries.map(entry => ({ escalacaoId: entry.id,
    total: isCurrentResult(entry.resultado, round, competition, entry.versao) ? entry.resultado!.total?.toFixed() ?? null : null })));
  const complete = !!competition.fechamentoDefinitivoEm && competition.fechamentoDefinitivoEm <= new Date()
    && ranked.length > 0 && ranked.every(row => row.total !== null);
  const positions = new Map(ranked.map(row => [row.escalacaoId, complete ? row.posicao : null]));
  for (const entry of entries) {
    const result = entry.resultado;
    if (!result || !isCurrentResult(result, round, competition, entry.versao)) continue;
    summaries.set(entry.id, { pontuacao: result.total?.toFixed() ?? null,
      estadoPontuacao: result.total === null ? 'INDISPONIVEL' : 'PARCIAL', revisao: result.revisao.toString(),
      atualizadoEm: result.atualizadoEm, posicao: positions.get(entry.id) ?? null });
  }
  return { summaries, round };
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const decimal = (v: unknown): v is string => typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v) && new Prisma.Decimal(v).isFinite();
const id = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** Whitelisted projection of the stored audit. Does not run scoring/substitution
 * rules, sum points, choose reserves or compute captain multipliers. */
export async function readResultDetail(tx: Prisma.TransactionClient, competition: Scope, lineup: Lineup,
  context: Awaited<ReturnType<typeof readResultSummaries>>): Promise<LineupResultDetailDto | undefined> {
  const summary = context.summaries.get(lineup.id);
  if (!summary || !context.round) return undefined;
  const result = await tx.fantasyEscalacaoResultado.findUnique({ where: { escalacaoId: lineup.id }, select: { ...metadata, auditoria: true } });
  if (!result || !isCurrentResult(result, context.round, competition, lineup.versao)) return undefined;
  const audit = object(result.auditoria);
  if (audit.escalacaoId !== lineup.id || audit.versaoEscalacao !== lineup.versao
    || !decimal(audit.total) || !result.total?.eq(audit.total)
    || !Array.isArray(audit.contributions) || audit.contributions.length !== 12
    || !Array.isArray(audit.substitutions) || !Array.isArray(audit.fontes)) return undefined;
  const selected = new Map(lineup.atletas.map(a => [a.catalogoAtletaId, a]));
  const contributions = audit.contributions.map(object);
  if (new Set(contributions.map(c => c.starter)).size !== 12 || new Set(contributions.map(c => c.athlete)).size !== 12
    || contributions.some(c => !id(c.starter) || !id(c.athlete) || !selected.has(c.starter) || !selected.has(c.athlete)
      || selected.get(c.starter)!.papel === 'RESERVA' || !decimal(c.points) || typeof c.multiplier !== 'number' || ![1,2].includes(c.multiplier))) return undefined;
  const subs = audit.substitutions.map(object);
  if (new Set(subs.map(s => s.in)).size !== subs.length || new Set(subs.map(s => s.out)).size !== subs.length
    || subs.some(s => !id(s.in) || !id(s.out) || selected.get(s.in)?.papel !== 'RESERVA' || selected.get(s.out)?.papel !== 'TITULAR'
      || selected.get(s.in)!.atleta.posicaoId !== selected.get(s.out)!.atleta.posicaoId
      || !['COMUM','MAGO'].includes(String(s.kind)) || !decimal(s.officialPoints) || !decimal(s.contribution)
      || !contributions.some(c => c.starter === s.out && c.athlete === s.in && c.multiplier === s.multiplier && c.points === s.contribution))
    || contributions.some(c => c.starter !== c.athlete && !subs.some(s => s.out === c.starter && s.in === c.athlete))) return undefined;
  const effectiveCaptain = contributions.find(c => c.starter === lineup.capitaoAtletaId && c.multiplier === 2);
  if (!effectiveCaptain || contributions.filter(c => c.multiplier === 2).length !== 1) return undefined;
  const official = await tx.fantasyPontuacaoAtleta.findMany({ where: { temporada: competition.temporada, rodada: competition.rodada,
    apuracaoId: context.round.id, atletaIdCartola: { in: lineup.atletas.map(a => a.atleta.atletaIdExterno) } },
    select: { atletaIdCartola: true, clubeIdCartola: true, posicaoId: true, estadoClube: true, estadoPosicao: true,
      estadoPontuacao: true, pontuacao: true, estadoParticipacao: true, entrouEmCampo: true,
      revisaoAlteracao: true, presenteNaUltimaLista: true } });
  const byExternal = new Map(official.map(a => [a.atletaIdCartola, a]));
  const origins = new Map(audit.fontes.map(object).filter(p => id(p.catalogoAtletaId)).map(p => [p.catalogoAtletaId as number, p.origem]));
  const proof = object(audit.evidenciaAusencias);
  const inferredValid = proof.eligible === true && proof.revision === summary.revisao && proof.sourceHash === result.hashFonte;
  const athletes = [...lineup.atletas].sort((a,b) => a.catalogoAtletaId-b.catalogoAtletaId).map(a => {
    const p = byExternal.get(a.atleta.atletaIdExterno);
    const valid = p && p.presenteNaUltimaLista && p.estadoClube === 'VALOR' && p.estadoPosicao === 'VALOR'
      && p.clubeIdCartola === a.atleta.clubeIdExterno && p.posicaoId === a.atleta.posicaoId && p.revisaoAlteracao <= context.round!.revisaoAtual;
    const inferred = origins.get(a.catalogoAtletaId) === 'NAO_PARTICIPACAO_INFERIDA_CARTOLA' && inferredValid && (!p || !p.presenteNaUltimaLista);
    const contribution = contributions.find(c => c.athlete === a.catalogoAtletaId);
    const sub = subs.find(s => s.in === a.catalogoAtletaId);
    const origin: ParticipationOrigin = inferred ? 'NAO_PARTICIPACAO_INFERIDA_CARTOLA'
      : valid ? 'REGISTRO_OFICIAL' : p ? 'IDENTIDADE_INCOMPATIVEL' : 'INFORMACAO_AUSENTE';
    return { catalogoAtletaId: a.catalogoAtletaId, papelOriginal: a.papel,
      pontuacaoOficial: valid && p.estadoPontuacao === 'VALOR' ? p.pontuacao?.toFixed() ?? null : null,
      pontuacaoContabilizada: contribution ? contribution.points as string : '0', multiplicador: contribution ? contribution.multiplier as number : 1,
      titularEfetivo: !!contribution, capitaoOriginal: a.catalogoAtletaId === lineup.capitaoAtletaId,
      capitaoEfetivo: a.catalogoAtletaId === effectiveCaptain.athlete, reservaMagoDesignado: a.catalogoAtletaId === lineup.reservaMagoAtletaId,
      reservaUtilizado: !!sub, utilizadoComoMago: sub?.kind === 'MAGO',
      entrouEmCampo: inferred ? false : valid && p.estadoParticipacao === 'VALOR' ? p.entrouEmCampo : null,
      origemParticipacao: origin };
  });
  return { ...summary, capitaoOriginalAtletaId: lineup.capitaoAtletaId, capitaoEfetivoAtletaId: effectiveCaptain.athlete as number,
    reservaMagoAtletaId: lineup.reservaMagoAtletaId, reservasUtilizados: subs.map(s => s.in as number), titularesSubstituidos: subs.map(s => s.out as number),
    contribuicoes: contributions.map(c => ({ titularOriginalAtletaId: c.starter as number, catalogoAtletaId: c.athlete as number,
      pontuacaoContabilizada: c.points as string, multiplicador: c.multiplier as number })), atletas: athletes,
    substituicoes: subs.map(s => ({ titularSaiuId: s.out as number, reservaEntrouId: s.in as number, regra: s.kind as 'COMUM' | 'MAGO',
      pontuacaoOficial: s.officialPoints as string, pontuacaoContabilizada: s.contribution as string, multiplicador: s.multiplier as number,
      herdouCapitao: s.out === lineup.capitaoAtletaId && s.multiplier === 2 })) };
}
