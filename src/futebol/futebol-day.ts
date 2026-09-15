export const FUTEBOL_DAY_TIMEZONE = 'America/Sao_Paulo';
const DAY = 24 * 60 * 60 * 1000;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUTEBOL_DAY_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

function localDay(instant: Date): string {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** First instant of a São Paulo calendar day, including historical DST changes. */
function startOfDay(day: string): Date {
  const midnightUtc = Date.parse(`${day}T00:00:00Z`);
  let lower = midnightUtc - DAY;
  let upper = midnightUtc + DAY;
  // São Paulo offsets fit this bracket. Searching the date boundary also handles
  // days whose local midnight was skipped: do not assume UTC-03 or a 24-hour day.
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (localDay(new Date(middle)) < day) lower = middle + 1;
    else upper = middle;
  }
  return new Date(lower);
}

/** Pure conversion: the caller captures the current instant exactly once. */
export function futebolDayInterval(now: Date) {
  const data = localDay(now);
  const nextDay = new Date(Date.parse(`${data}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  return { data, timezone: FUTEBOL_DAY_TIMEZONE, inicioUtc: startOfDay(data), fimUtc: startOfDay(nextDay) };
}
