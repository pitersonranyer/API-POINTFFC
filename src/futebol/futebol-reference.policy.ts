/** A season must already be scoped to one competition before calling this policy. */
export interface ReferenceMatch {
  id: number;
  rodada: number | null;
  fase: string | null;
  dataHoraUtc: string;
  status: string;
}

const DAY = 24 * 60 * 60 * 1000;
// Inferred blocks, not official calendar windows. Outliers never extend a block.
const BLOCK_SPAN = 7 * DAY;
// Keep the final match day through 06:00 UTC, including games crossing midnight.
const END_OF_DAY_GRACE = 6 * 60 * 60 * 1000;
const RESOLVED = new Set(['FINISHED', 'AWARDED']);

interface Stage<T> {
  fase: string | null;
  rodada: number | null;
  games: T[];
  core: T[];
  expected: number;
  quorum: number;
}

const date = (game: ReferenceMatch) => Date.parse(game.dataHoraUtc);
const orderGames = (a: ReferenceMatch, b: ReferenceMatch) => date(a) - date(b) || a.id - b.id;

/** Largest seven-day cluster; ties prefer shortest span, then earliest start. */
function regularBlock<T extends ReferenceMatch>(games: T[], quorum: number): T[] {
  // Dates also survive postponements/suspensions and unknown provider statuses.
  // Changing a status cannot remove a match from its collective calendar block.
  const dates = games.filter(game => Number.isFinite(date(game))).sort(orderGames);
  let best: T[] = [];
  for (let left = 0, right = 0; left < dates.length; left++) {
    while (right < dates.length && date(dates[right]) - date(dates[left]) < BLOCK_SPAN) right++;
    const candidate = dates.slice(left, right);
    if (candidate.length > best.length || (candidate.length === best.length &&
      date(candidate[candidate.length - 1]) - date(candidate[0]) < date(best[best.length - 1]) - date(best[0]))) best = candidate;
  }
  return best.length >= quorum && best.filter(game => game.status !== 'CANCELLED').length >= quorum ? best : [];
}

/**
 * Stateless, conservative inference from collective calendar evidence.
 * No live-game priority, upcoming-game selection or highest-finished-game fallback.
 * Sparse/fragmented stages cannot establish progress by themselves.
 */
export function competitionReference<T extends ReferenceMatch>(matches: T[], now: Date) {
  const grouped = new Map<string, Stage<T>>();
  for (const game of [...matches].sort(orderGames)) {
    if (game.rodada === null && game.fase === null) continue;
    const key = JSON.stringify([game.fase, game.rodada]);
    let stage = grouped.get(key);
    if (!stage) {
      stage = { fase: game.fase, rodada: game.rodada, games: [], core: [], expected: 0, quorum: 0 };
      grouped.set(key, stage);
    }
    stage.games.push(game);
  }
  const stages = [...grouped.values()];
  const expectedByPhase = new Map<string | null, number>();
  for (const stage of stages) expectedByPhase.set(stage.fase, Math.max(expectedByPhase.get(stage.fase) ?? 0, stage.games.length));
  for (const stage of stages) {
    stage.expected = expectedByPhase.get(stage.fase)!;
    stage.quorum = Math.max(2, Math.floor(stage.expected / 2) + 1);
    stage.core = regularBlock(stage.games, stage.quorum);
  }

  // Infer phase order from collective blocks, never by comparing their round numbers.
  const phaseStart = new Map<string | null, number>();
  for (const stage of stages) if (stage.core.length) {
    phaseStart.set(stage.fase, Math.min(phaseStart.get(stage.fase) ?? Infinity, date(stage.core[0])));
  }
  stages.sort((a, b) => {
    if (a.fase === b.fase) return (a.rodada ?? Infinity) - (b.rodada ?? Infinity);
    const startA = phaseStart.get(a.fase) ?? Infinity;
    const startB = phaseStart.get(b.fase) ?? Infinity;
    return (startA < startB ? -1 : startA > startB ? 1 : 0) || (a.fase ?? '').localeCompare(b.fase ?? '');
  });
  // Keep sufficiently populated but fragmented stages in the sequence. Losing
  // a core must not make one rescheduled game skip an entire intervening round.
  const regular = stages.filter(stage => stage.games.filter(game => game.status !== 'CANCELLED').length >= stage.quorum);
  const time = now.getTime();
  let referenceIndex = regular.some(stage => stage.core.length) ? 0 : -1;
  for (let index = 0; index < regular.length; index++) {
    const stage = regular[index];
    if (!stage.core.length) continue;
    const started = stage.core.filter(game => date(game) <= time).length >= stage.quorum;
    const lastKickoff = date(stage.core[stage.core.length - 1]);
    const blockEnd = (Math.floor(lastKickoff / DAY) + 1) * DAY + END_OF_DAY_GRACE;
    const finished = stage.core.every(game => RESOLVED.has(game.status) && date(game) <= time);
    if (started) referenceIndex = index;
    if (finished || time >= blockEnd) referenceIndex = Math.min(index + 1, regular.length - 1);
  }
  const reference = regular[referenceIndex] ?? null;
  const next = reference ? regular[referenceIndex + 1] ?? null : null;
  const referencePosition = reference ? stages.indexOf(reference) : -1;
  const previous = reference ? stages.slice(0, referencePosition) : stages;
  const completed = stages.slice(0, referencePosition + 1).filter(stage => stage.core.length &&
    stage.games.length === stage.expected && stage.games.every(game => RESOLVED.has(game.status) && date(game) <= time));
  const lastCompleted = completed[completed.length - 1] ?? null;
  return {
    rodadaReferencia: reference?.rodada ?? null,
    faseReferencia: reference?.fase ?? null,
    ultimaRodadaConcluida: lastCompleted?.rodada ?? null,
    faseUltimaRodadaConcluida: lastCompleted?.fase ?? null,
    proximaRodada: next?.rodada ?? null,
    faseProximaRodada: next?.fase ?? null,
    partidasPendentes: previous.flatMap(stage => stage.games).filter(game => !RESOLVED.has(game.status) && game.status !== 'CANCELLED').sort(orderGames),
    jogos: reference?.games ?? [],
  };
}
