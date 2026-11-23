/** Timezone helpers. The clinic's IANA zone drives every date shown or requested (RN-009, spec 16.3). */

export function tzOffsetMs(at: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Instant of local midnight for `ymd` (YYYY-MM-DD) in `tz`. Two passes settle DST edges. */
export function zonedStartOfDay(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMs(new Date(guess), tz);
  return new Date(guess - tzOffsetMs(new Date(first), tz));
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function todayIn(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function dayRange(ymd: string, tz: string): { from: Date; to: Date } {
  return { from: zonedStartOfDay(ymd, tz), to: zonedStartOfDay(addDays(ymd, 1), tz) };
}

export function formatTime(d: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('es-AR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d));
}

export function formatDayLong(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const text = new Intl.DateTimeFormat('es-AR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatDateTimeLong(d: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('es-AR', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(d));
}

export function minutesOfDay(d: Date | string, tz: string): number {
  const [h, m] = formatTime(d, tz).split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export function tzLabel(tz: string, at: Date = new Date()): string {
  const off = tzOffsetMs(at, tz) / 60_000;
  const sign = off < 0 ? '−' : '+';
  const abs = Math.abs(off);
  return `${tz.replace(/_/g, ' ')} (UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')})`;
}
