import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

export const NORMALIZER_VERSION = 'cartola-observation-v1';
export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export class ObservationError extends Error {
  constructor(public readonly code: string) { super(code); }
}
class NumericToken { constructor(readonly token: string) {} }
type JsonValue = null | boolean | string | NumericToken | JsonValue[] | { [key: string]: JsonValue };

/** Strict JSON parser: no Number conversion, duplicate keys rejected at every depth. */
export function parseOfficialJson(text: string): JsonValue {
  if (Buffer.byteLength(text, 'utf8') > 8 * 1024 * 1024) throw new ObservationError('PAYLOAD_TOO_LARGE');
  let i = 0;
  const fail = (): never => { throw new ObservationError('INVALID_JSON'); };
  const ws = () => { while (/[\x20\t\n\r]/.test(text[i] ?? '') && i < text.length) i++; };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      const char = text[i++];
      if (char === '"') {
        try { return JSON.parse(text.slice(start, i)) as string; } catch { return fail(); }
      }
      if (char === '\\') i++;
    }
    return fail();
  };
  const value = (depth: number): JsonValue => {
    if (depth > 64) return fail();
    ws();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; ws();
      const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      if (text[i] === '}') { i++; return result; }
      for (;;) {
        ws(); if (text[i] !== '"') return fail();
        const key = string();
        if (Object.prototype.hasOwnProperty.call(result, key)) throw new ObservationError('DUPLICATE_JSON_KEY');
        ws(); if (text[i++] !== ':') return fail();
        result[key] = value(depth + 1); ws();
        const end = text[i++]; if (end === '}') return result;
        if (end !== ',') return fail();
      }
    }
    if (text[i] === '[') {
      i++; ws(); const result: JsonValue[] = [];
      if (text[i] === ']') { i++; return result; }
      for (;;) {
        result.push(value(depth + 1)); ws(); const end = text[i++];
        if (end === ']') return result; if (end !== ',') return fail();
      }
    }
    for (const [word, literal] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, i)) { i += word.length; return literal; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!match) return fail();
    i += match[0].length; return new NumericToken(match[0]);
  };
  const result = value(0); ws(); if (i !== text.length) return fail(); return result;
}
export function object(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof NumericToken) {
    throw new ObservationError('INVALID_OBJECT');
  }
  return value;
}
function integer(value: JsonValue, max = 4294967295): number {
  if (!(value instanceof NumericToken) || !/^\d+$/.test(value.token)) throw new ObservationError('INVALID_ID');
  const n = Number(value.token);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new ObservationError('INVALID_ID');
  return n;
}
function decimal(value: JsonValue): { token: string; canonical: string; value: Prisma.Decimal } {
  if (!(value instanceof NumericToken) || value.token.length > 128) throw new ObservationError('INVALID_DECIMAL');
  // Bound exponents before expansion; never silently round to the database scale.
  const exponent = /[eE]([+-]?\d+)$/.exec(value.token);
  if (exponent && Math.abs(Number(exponent[1])) > 100) throw new ObservationError('DECIMAL_OVERFLOW');
  const d = new Prisma.Decimal(value.token);
  if (!d.isFinite() || d.decimalPlaces() > 18 || d.abs().gte('100000000000000000000')) {
    throw new ObservationError('DECIMAL_OVERFLOW');
  }
  return { token: value.token, canonical: d.isZero() ? '0' : d.toFixed(), value: d };
}
type FieldState = 'AUSENTE' | 'NULO' | 'VALOR';
function state(row: Record<string, JsonValue>, key: string): FieldState {
  return !Object.prototype.hasOwnProperty.call(row, key) ? 'AUSENTE' : row[key] === null ? 'NULO' : 'VALOR';
}
export function normalizeOfficial(text: string, temporada: number, rodada: number, version = NORMALIZER_VERSION) {
  const payload = object(parseOfficialJson(text));
  if (integer(payload.rodada, 38) !== rodada) throw new ObservationError('ROUND_MISMATCH');
  if (payload.temporada !== undefined && integer(payload.temporada, 65535) !== temporada) throw new ObservationError('SEASON_MISMATCH');
  const entries = Object.entries(object(payload.atletas));
  if (entries.length > 10000) throw new ObservationError('TOO_MANY_ATHLETES');
  if (payload.total_atletas !== undefined) {
    if (!(payload.total_atletas instanceof NumericToken) || !/^\d+$/.test(payload.total_atletas.token)
      || Number(payload.total_atletas.token) !== entries.length) throw new ObservationError('COUNT_MISMATCH');
  }
  const seen = new Set<number>();
  const athletes = entries.map(([key, raw]) => {
    if (!/^[1-9]\d*$/.test(key)) throw new ObservationError('INVALID_ID');
    const atletaIdCartola = integer(new NumericToken(key));
    if (seen.has(atletaIdCartola)) throw new ObservationError('DUPLICATE_ATHLETE');
    seen.add(atletaIdCartola);
    const a = object(raw);
    const estadoClube = state(a, 'clube_id'), estadoPosicao = state(a, 'posicao_id');
    const estadoPontuacao = state(a, 'pontuacao'), estadoParticipacao = state(a, 'entrou_em_campo');
    const estadoScouts = state(a, 'scout');
    const clubeIdCartola = estadoClube === 'VALOR' ? integer(a.clube_id) : null;
    const posicaoId = estadoPosicao === 'VALOR' ? integer(a.posicao_id, 6) : null;
    const points = estadoPontuacao === 'VALOR' ? decimal(a.pontuacao) : null;
    if (estadoParticipacao === 'VALOR' && typeof a.entrou_em_campo !== 'boolean') throw new ObservationError('INVALID_PARTICIPATION');
    const entrouEmCampo = estadoParticipacao === 'VALOR' ? a.entrou_em_campo as boolean : null;
    const participacaoObservada = entrouEmCampo === null ? 'NAO_INFORMADA' as const
      : entrouEmCampo ? 'INFORMADA_TRUE' as const : 'INFORMADA_FALSE' as const;
    const scouts = estadoScouts === 'VALOR' ? Object.fromEntries(Object.entries(object(a.scout))
      .sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0).map(([code, n]) => [code, decimal(n).canonical])) : null;
    const canonical = { atletaIdCartola, clube: [estadoClube, clubeIdCartola], posicao: [estadoPosicao, posicaoId],
      pontuacao: [estadoPontuacao, points?.canonical ?? null], participacao: [estadoParticipacao, entrouEmCampo], scouts: [estadoScouts, scouts] };
    return { atletaIdCartola, clubeIdCartola, posicaoId, estadoClube, estadoPosicao, estadoPontuacao,
      pontuacaoTokenOriginal: points?.token ?? null, pontuacao: points?.value ?? null,
      estadoParticipacao, entrouEmCampo, participacaoObservada, estadoScouts, scouts,
      hashConteudo: sha256(JSON.stringify(canonical)), canonical };
  }).sort((a, b) => a.atletaIdCartola - b.atletaIdCartola);
  return { athletes, hashPayload: sha256(text), hashConteudo: sha256(JSON.stringify({ schema: 1,
    fonte: 'CARTOLA_PONTUADOS', temporada, rodada, normalizador: version, atletas: athletes.map(a => a.canonical) })), version };
}
