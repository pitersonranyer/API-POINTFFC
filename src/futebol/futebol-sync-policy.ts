export const FUTEBOL_TIMEZONE = 'America/Sao_Paulo';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUTEBOL_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function localParts(date: Date) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour),
    wall: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) };
}
function slot(date: Date, hour: number) {
  const parts = localParts(date);
  let value = Date.parse(`${parts.day}T${String(hour).padStart(2, '0')}:00:00Z`);
  const target = value;
  // Resolve wall time using the IANA zone, without depending on process TZ.
  for (let i = 0; i < 3; i++) value += target - localParts(new Date(value)).wall;
  return value;
}
export interface SyncMatch { dataHoraUtc: Date; status: string }
export function futebolSyncDecision(now: Date, last: Date | null, matches: SyncMatch[]) {
  const time = now.getTime();
  const elapsed = last ? time - last.getTime() : Infinity;
  if (!matches.length) return { due: true, reason: 'carga-inicial', interval: 5 * MINUTE };
  const today = localParts(now).day;
  const todaysMatches = matches.filter(m => localParts(m.dataHoraUtc).day === today);
  const pending = (m: SyncMatch) => ['TIMED', 'SCHEDULED'].includes(m.status);
  const live = matches.some(m => ['IN_PLAY', 'PAUSED'].includes(m.status) ||
    (pending(m) && time >= m.dataHoraUtc.getTime() && time < m.dataHoraUtc.getTime() + 3 * HOUR));
  const soon = matches.some(m => pending(m) && m.dataHoraUtc.getTime() > time && m.dataHoraUtc.getTime() <= time + HOUR);
  const upcoming = todaysMatches.some(m => pending(m) && m.dataHoraUtc.getTime() > time);
  const interval = live ? 5 * MINUTE : soon ? 10 * MINUTE : HOUR;
  if (!last) return { due: true, reason: 'sem-historico', interval };
  if (live || soon || upcoming) return { due: elapsed >= interval, reason: live ? 'em-andamento' : soon ? 'inicio-proximo' : 'jogos-no-dia', interval };

  // One conservative final reconciliation per completed match day, including
  // a day missed during downtime. The successful-sync watermark survives restarts.
  const days = new Map<string, number>();
  for (const match of matches) {
    const day = localParts(match.dataHoraUtc).day;
    days.set(day, Math.max(days.get(day) ?? 0, match.dataHoraUtc.getTime() + 3 * HOUR));
  }
  const finalDue = [...days.values()].some(end => end <= time && last.getTime() < end);
  if (finalDue) return { due: elapsed >= 5 * MINUTE, reason: 'reconciliacao-final', interval: 5 * MINUTE };
  const hour = localParts(now).hour;
  const latestSlot = hour >= 18 ? slot(now, 18) : hour >= 6 ? slot(now, 6) : slot(new Date(time - 24 * HOUR), 18);
  return { due: last.getTime() < latestSlot, reason: 'janela-06-18', interval: 5 * MINUTE };
}
