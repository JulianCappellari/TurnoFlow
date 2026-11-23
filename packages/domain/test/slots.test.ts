import { describe, expect, it } from 'vitest';
import { generateSlots, isDomainError } from '../src/index.ts';

const BA = 'America/Argentina/Buenos_Aires'; // UTC-3, no DST
const base = {
  timezone: BA,
  rules: [{ weekday: 1, startMinute: 9 * 60, endMinute: 11 * 60 }], // Mondays 09:00-11:00
  blocks: [], busy: [], durationMin: 30, bufferMin: 0, stepMin: 30,
  now: new Date('2030-01-01T00:00:00Z'),
};
// Monday 2030-01-07, whole local day
const day = { from: new Date('2030-01-07T03:00:00Z'), to: new Date('2030-01-08T03:00:00Z') };
const iso = (s: { startsAt: Date }[]) => s.map((x) => x.startsAt.toISOString());

describe('generateSlots', () => {
  it('generates a grid in UTC from local clinic hours', () => {
    const s = generateSlots({ ...base, ...day });
    expect(iso(s)).toEqual([
      '2030-01-07T12:00:00.000Z', '2030-01-07T12:30:00.000Z', '2030-01-07T13:00:00.000Z', '2030-01-07T13:30:00.000Z',
    ]);
    expect(s[0]!.endsAt.toISOString()).toBe('2030-01-07T12:30:00.000Z');
  });

  it('ignores days without rules', () => {
    expect(generateSlots({ ...base, from: new Date('2030-01-08T03:00:00Z'), to: new Date('2030-01-09T03:00:00Z') })).toEqual([]);
  });

  it('adds buffer to the occupancy and blocks neighbours that would overlap it', () => {
    const s = generateSlots({ ...base, ...day, bufferMin: 15, stepMin: 15 });
    expect(s[0]!.occupiedUntil.toISOString()).toBe('2030-01-07T12:45:00.000Z');
    const withBusy = generateSlots({
      ...base, ...day, bufferMin: 15, stepMin: 15,
      busy: [{ start: new Date('2030-01-07T12:00:00Z'), end: new Date('2030-01-07T12:45:00Z') }],
    });
    expect(withBusy[0]!.startsAt.toISOString()).toBe('2030-01-07T12:45:00.000Z');
  });

  it('excludes slots whose practice intersects a block, but not adjacent ones', () => {
    const s = generateSlots({
      ...base, ...day,
      blocks: [{ start: new Date('2030-01-07T12:30:00Z'), end: new Date('2030-01-07T13:00:00Z') }],
    });
    expect(iso(s)).toEqual(['2030-01-07T12:00:00.000Z', '2030-01-07T13:00:00.000Z', '2030-01-07T13:30:00.000Z']);
  });

  it('respects minimum notice and never offers the past', () => {
    const now = new Date('2030-01-07T12:10:00Z');
    expect(generateSlots({ ...base, ...day, now })[0]!.startsAt.toISOString()).toBe('2030-01-07T12:30:00.000Z');
    expect(generateSlots({ ...base, ...day, now, minNoticeMin: 60 })[0]!.startsAt.toISOString()).toBe('2030-01-07T13:30:00.000Z');
  });

  it('requires the practice to fit in the window', () => {
    const s = generateSlots({ ...base, ...day, durationMin: 45, stepMin: 15 });
    expect(s.at(-1)!.endsAt.toISOString()).toBe('2030-01-07T14:00:00.000Z');
  });

  it('supports split shifts and a window ending at midnight (1440)', () => {
    const s = generateSlots({
      ...base, ...day, durationMin: 60, stepMin: 60,
      rules: [
        { weekday: 1, startMinute: 8 * 60, endMinute: 9 * 60 },
        { weekday: 1, startMinute: 23 * 60, endMinute: 1440 },
      ],
    });
    expect(iso(s)).toEqual(['2030-01-07T11:00:00.000Z', '2030-01-08T02:00:00.000Z']);
  });

  it('keeps wall-clock hours across DST changes (RN-009)', () => {
    const rules = [{ weekday: 7, startMinute: 9 * 60, endMinute: 10 * 60 }]; // Sundays 09:00
    const slotAt = (from: string, to: string) =>
      generateSlots({
        ...base, timezone: 'America/New_York', rules, durationMin: 60,
        from: new Date(from), to: new Date(to), now: new Date('2026-01-01T00:00:00Z'),
      });
    // 2026-03-08 is the US spring-forward Sunday: 09:00 local is 13:00Z; the Sunday before it is 14:00Z.
    expect(iso(slotAt('2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z'))).toEqual(['2026-03-01T14:00:00.000Z']);
    expect(iso(slotAt('2026-03-08T00:00:00Z', '2026-03-09T00:00:00Z'))).toEqual(['2026-03-08T13:00:00.000Z']);
  });

  it('rejects invalid parameters and timezones', () => {
    expect(() => generateSlots({ ...base, ...day, durationMin: 0 })).toThrow();
    try {
      generateSlots({ ...base, ...day, timezone: 'Mars/Olympus' });
      expect.unreachable();
    } catch (e) {
      expect(isDomainError(e, 'VALIDATION')).toBe(true);
    }
  });
});
