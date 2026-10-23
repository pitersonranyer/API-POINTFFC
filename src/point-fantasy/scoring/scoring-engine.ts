import { Prisma } from '@prisma/client';

// The source stores DECIMAL(38,18). Leave room for sums and captain doubling.
const Decimal = Prisma.Decimal.clone({ precision: 80 });
export interface ScoringPlayer {
  id: number;
  position: number;
  role: 'TITULAR' | 'RESERVA' | 'TECNICO';
  points: string | null;
  played: boolean | null;
}
export interface Substitution {
  out: number; in: number; kind: 'COMUM' | 'MAGO'; multiplier: number;
  officialPoints: string; contribution: string;
}
export interface ScoringResult {
  total: string | null;
  missing: number[];
  substitutions: Substitution[];
  contributions: { starter: number; athlete: number; multiplier: number; points: string }[];
}

/** Small exhaustive matching per position: at most two reserves, five starters.
 * A Mago can enter as a common reserve OR as Mago, never both. Compare complete
 * assignments including captain inheritance, so the two rules cannot conflict.
 */
export function scoreLineup(players: ScoringPlayer[], captain: number, mago: number): ScoringResult {
  const sorted = [...players].sort((a, b) => a.id - b.id);
  const starters = sorted.filter(p => p.role === 'TITULAR');
  const reserves = sorted.filter(p => p.role === 'RESERVA');
  const coaches = sorted.filter(p => p.role === 'TECNICO');
  if (new Set(sorted.map(p => p.id)).size !== sorted.length || starters.length !== 11
    || coaches.length !== 1 || coaches[0].position !== 6 || reserves.length !== 5
    || !starters.some(p => p.id === captain) || !reserves.some(p => p.id === mago)
    || [...starters, ...reserves].some(p => p.position < 1 || p.position > 5)) throw Error('INVALID_SCORING_LINEUP');
  const value = (p: ScoringPlayer) => p.played === false ? new Decimal(0)
    : p.points === null ? null : new Decimal(p.points);
  const missing = sorted.filter(p => value(p) === null).map(p => p.id);
  if (missing.length) return { total: null, missing, substitutions: [], contributions: [] };
  if (sorted.some(p => !value(p)!.isFinite())) throw Error('INVALID_SCORING_POINTS');
  let total = value(coaches[0])!;
  const contributions: ScoringResult['contributions'] = [{ starter: coaches[0].id,
    athlete: coaches[0].id, multiplier: 1, points: total.toFixed() }];
  const substitutions: Substitution[] = [];
  for (const position of [1, 2, 3, 4, 5]) {
    const slots = starters.filter(p => p.position === position);
    const bench = reserves.filter(p => p.position === position);
    let best: { total: InstanceType<typeof Decimal>; subs: Substitution[];
      rows: ScoringResult['contributions'] } | null = null;
    const search = (index: number, used: Set<number>, sum: InstanceType<typeof Decimal>,
      subs: Substitution[], rows: ScoringResult['contributions']) => {
      if (index === slots.length) {
        // Common replacements take effect first. The Mago chooses the lowest
        // remaining original starter, never a reserve that has just entered.
        const magic = subs.find(s => s.kind === 'MAGO');
        if (magic) {
          const commonOut = new Set(subs.filter(s => s.kind === 'COMUM').map(s => s.out));
          const eligible = slots.filter(s => !commonOut.has(s.id));
          const target = slots.find(s => s.id === magic.out)!;
          if (eligible.some(s => value(s)!.lt(value(target)!))) return;
        }
        // Keep the first maximum: original slots and reserve IDs are ordered.
        if (best === null || sum.gt(best.total) || (sum.eq(best.total)
          && subs.filter(s => s.kind === 'COMUM').length > best.subs.filter(s => s.kind === 'COMUM').length)) best = { total: sum, subs, rows };
        return;
      }
      const slot = slots[index], multiplier = slot.id === captain ? 2 : 1;
      const original = value(slot)!;
      const row = (athlete: number, points: InstanceType<typeof Decimal>) => ({
        starter: slot.id, athlete, multiplier, points: points.times(multiplier).toFixed() });
      search(index + 1, used, sum.plus(original.times(multiplier)), subs, [...rows, row(slot.id, original)]);
      for (const reserve of bench) {
        if (used.has(reserve.id) || reserve.played === false) continue;
        const points = value(reserve)!;
        const choices: { kind: Substitution['kind']; points: InstanceType<typeof Decimal> }[] = [];
        if (slot.played === false) choices.push({ kind: 'COMUM', points: Decimal.max(0, points) });
        if (reserve.id === mago && points.gt(original)) choices.push({ kind: 'MAGO', points });
        for (const choice of choices) {
          const contribution = choice.points.times(multiplier);
          search(index + 1, new Set([...used, reserve.id]), sum.plus(contribution), [...subs, {
            out: slot.id, in: reserve.id, kind: choice.kind, multiplier,
            officialPoints: points.toFixed(), contribution: contribution.toFixed(),
          }], [...rows, row(reserve.id, choice.points)]);
        }
      }
    };
    search(0, new Set(), new Decimal(0), [], []);
    const chosen = best! as { total: InstanceType<typeof Decimal>; subs: Substitution[]; rows: ScoringResult['contributions'] };
    total = total.plus(chosen.total);
    substitutions.push(...chosen.subs.sort((a, b) =>
      (a.kind === 'COMUM' ? 0 : 1) - (b.kind === 'COMUM' ? 0 : 1) || a.out - b.out));
    contributions.push(...chosen.rows);
  }
  return { total: total.toFixed(), missing: [], substitutions, contributions };
}

export function rankScores<T extends { escalacaoId: number; total: string | null }>(rows: T[]) {
  const sorted = [...rows].sort((a, b) => a.total === null ? (b.total === null ? a.escalacaoId - b.escalacaoId : 1)
    : b.total === null ? -1 : new Decimal(b.total).cmp(a.total) || a.escalacaoId - b.escalacaoId);
  let rank = 0;
  return sorted.map((row, i) => {
    if (row.total !== null && (i === 0 || !new Decimal(row.total).eq(sorted[i - 1].total!))) rank = i + 1;
    return { ...row, posicao: row.total === null ? null : rank };
  });
}
