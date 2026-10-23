import { FantasyPontuacaoAtleta, Prisma } from '@prisma/client';
import { normalizeOfficial, sha256 } from './official-normalizer';

export const scoringFields = ['atletaIdCartola','clubeIdCartola','posicaoId','estadoClube','estadoPosicao',
  'pontuacao','pontuacaoTokenOriginal','estadoPontuacao','entrouEmCampo','estadoParticipacao','participacaoObservada',
  'scouts','estadoScouts','presenteNaUltimaLista','hashConteudo','versaoNormalizador'] as const;
export type ScoringContent = Pick<FantasyPontuacaoAtleta, typeof scoringFields[number]>;
export type Change = { before: FantasyPontuacaoAtleta | null; after: ScoringContent;
  type: 'INCLUSAO' | 'ALTERACAO' | 'OMISSAO' | 'REAPARECIMENTO' };
export const stableJson = (value: unknown): string => JSON.stringify(value, (_, v: unknown) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const record = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  }
  return v;
});
export function currentScoringPlan(existing: FantasyPontuacaoAtleta[], normalized: ReturnType<typeof normalizeOfficial>,
  temporada: number, rodada: number, preserveOmissions = false) {
  const old = new Map(existing.map(a => [a.atletaIdCartola, a]));
  const effective = new Map<number, ScoringContent>(old);
  const seen = new Set<number>();
  const changes: Change[] = [];
  for (const a of normalized.athletes) {
    seen.add(a.atletaIdCartola);
    const before = old.get(a.atletaIdCartola);
    if (before && before.hashConteudo === a.hashConteudo && before.presenteNaUltimaLista
      && before.versaoNormalizador === normalized.version) continue;
    const { canonical, ...content } = a; void canonical;
    const after: ScoringContent = { ...content, presenteNaUltimaLista: true, versaoNormalizador: normalized.version };
    changes.push({ before: before ?? null, after,
      type: !before ? 'INCLUSAO' : !before.presenteNaUltimaLista ? 'REAPARECIMENTO' : 'ALTERACAO' });
    effective.set(a.atletaIdCartola, after);
  }
  for (const before of existing) {
    if (!preserveOmissions && before.presenteNaUltimaLista && !seen.has(before.atletaIdCartola)) {
      const after = { ...before, presenteNaUltimaLista: false };
      changes.push({ before, after, type: 'OMISSAO' }); effective.set(before.atletaIdCartola, after);
    }
  }
  const hash = sha256(stableJson({ schema: 'current-scoring-v1', temporada, rodada,
    atletas: [...effective.values()].sort((a,b) => a.atletaIdCartola - b.atletaIdCartola)
      .map(a => [a.atletaIdCartola, a.hashConteudo, a.presenteNaUltimaLista, a.versaoNormalizador]) }));
  return { changes, hash, inserted: changes.filter(c => c.type === 'INCLUSAO').length,
    omitted: changes.filter(c => c.type === 'OMISSAO').length,
    updated: changes.filter(c => c.type === 'ALTERACAO' || c.type === 'REAPARECIMENTO').length };
}
function auditValues(a: ScoringContent): Record<string, Prisma.JsonValue> {
  return { clubeIdCartola: a.clubeIdCartola, posicaoId: a.posicaoId, estadoClube: a.estadoClube, estadoPosicao: a.estadoPosicao,
    pontuacao: a.pontuacao?.toFixed() ?? null, pontuacaoTokenOriginal: a.pontuacaoTokenOriginal, estadoPontuacao: a.estadoPontuacao,
    entrouEmCampo: a.entrouEmCampo, estadoParticipacao: a.estadoParticipacao, participacaoObservada: a.participacaoObservada,
    scouts: a.scouts, estadoScouts: a.estadoScouts, presenteNaUltimaLista: a.presenteNaUltimaLista,
    versaoNormalizador: a.versaoNormalizador };
}
const groups = [['clubeIdCartola','estadoClube'], ['posicaoId','estadoPosicao'],
  ['pontuacao','pontuacaoTokenOriginal','estadoPontuacao'], ['entrouEmCampo','estadoParticipacao','participacaoObservada'],
  ['scouts','estadoScouts'], ['presenteNaUltimaLista'], ['versaoNormalizador']];
export function changeEvidence(change: Change, revision: bigint): Prisma.InputJsonObject {
  const before = change.before ? auditValues(change.before) : null, after = auditValues(change.after);
  const keys = before ? groups.filter(group => group.some(key => stableJson(before[key]) !== stableJson(after[key]))).flat() : Object.keys(after);
  return { atletaIdCartola: change.after.atletaIdCartola, tipo: change.type, revisao: revision.toString(),
    hashAnterior: change.before?.hashConteudo ?? null, hashNovo: change.after.hashConteudo,
    antes: before ? Object.fromEntries(keys.map(key => [key, before[key]])) : null,
    depois: Object.fromEntries(keys.map(key => [key, after[key]])) };
}
