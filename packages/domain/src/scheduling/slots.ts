import { DateTime } from 'luxon';
import { DomainError } from '../errors.ts';
import type { GenerateSlotsInput, Interval, Slot } from './types.ts';

const MIN = 60_000;

const overlaps = (aStart: number, aEnd: number, b: Interval): boolean =>
  aStart < b.end.getTime() && b.start.getTime() < aEnd;

/** Wall-clock minute-of-day on a local calendar day, DST-safe (calendar math, not elapsed time). */
function atLocalMinute(day: DateTime, minute: number): DateTime {
  if (minute >= 1440) return day.plus({ days: 1 }).startOf('day');
  return day.set({ hour: Math.floor(minute / 60), minute: minute % 60, second: 0, millisecond: 0 });
}

export function assertValidTimezone(timezone: string): void {
  if (!DateTime.now().setZone(timezone).isValid) {
    throw new DomainError('VALIDATION', `Invalid IANA timezone: ${timezone}`);
  }
}

/**
 * Pure, deterministic slot generation (RF-028, RN-003/005/009).
 * The backend is the only source of reservable slots; nothing here talks to the database.
 *
 * Modeling assumption (see DECISIONS): the practice (not the trailing buffer) must fit
 * inside the working window; the buffer may extend past the end of the window.
 */
export function generateSlots(input: GenerateSlotsInput): Slot[] {
  const { timezone, rules, blocks, busy, durationMin, bufferMin, stepMin, from, to, now } = input;
  if (!(durationMin > 0) || !Number.isInteger(durationMin)) throw new DomainError('VALIDATION', 'durationMin must be a positive integer');
  if (!(stepMin > 0) || !Number.isInteger(stepMin)) throw new DomainError('VALIDATION', 'stepMin must be a positive integer');
  if (bufferMin < 0 || !Number.isInteger(bufferMin)) throw new DomainError('VALIDATION', 'bufferMin must be a non-negative integer');
  assertValidTimezone(timezone);
  if (!(from.getTime() < to.getTime())) return [];

  const earliest = Math.max(from.getTime(), now.getTime() + (input.minNoticeMin ?? 0) * MIN);
  const latestExclusive = to.getTime();
  const out = new Map<number, Slot>();

  const lastDay = DateTime.fromMillis(latestExclusive - 1, { zone: timezone }).startOf('day');
  for (
    let day = DateTime.fromMillis(from.getTime(), { zone: timezone }).startOf('day');
    day <= lastDay;
    day = day.plus({ days: 1 })
  ) {
    for (const rule of rules) {
      if (rule.weekday !== day.weekday) continue;
      const winStart = atLocalMinute(day, rule.startMinute).toMillis();
      const winEnd = atLocalMinute(day, rule.endMinute).toMillis();
      for (let start = winStart; start + durationMin * MIN <= winEnd; start += stepMin * MIN) {
        if (start < earliest || start >= latestExclusive) continue;
        const end = start + durationMin * MIN;
        const occupiedUntil = end + bufferMin * MIN;
        if (blocks.some((b) => overlaps(start, end, b))) continue;
        if (busy.some((b) => overlaps(start, occupiedUntil, b))) continue;
        out.set(start, { startsAt: new Date(start), endsAt: new Date(end), occupiedUntil: new Date(occupiedUntil) });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
