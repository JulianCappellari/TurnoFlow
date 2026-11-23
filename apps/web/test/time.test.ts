import { describe, expect, it } from 'vitest';
import { addDays, dayRange, formatTime, minutesOfDay, todayIn, tzLabel, zonedStartOfDay } from '../src/time.ts';

const BA = 'America/Argentina/Buenos_Aires';

describe('time helpers', () => {
  it('maps a local day to UTC instants (Buenos Aires is UTC-3)', () => {
    expect(zonedStartOfDay('2030-01-07', BA).toISOString()).toBe('2030-01-07T03:00:00.000Z');
    const r = dayRange('2030-01-07', BA);
    expect(r.to.toISOString()).toBe('2030-01-08T03:00:00.000Z');
  });
  it('handles DST days (New York has a 23 h day on 2026-03-08)', () => {
    const r = dayRange('2026-03-08', 'America/New_York');
    expect(r.from.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });
  it('formats in the clinic zone, not the browser zone', () => {
    expect(formatTime('2030-01-07T12:00:00Z', BA)).toBe('09:00');
    expect(minutesOfDay('2030-01-07T15:30:00Z', BA)).toBe(12 * 60 + 30);
  });
  it('computes the clinic-local today around midnight UTC', () => {
    expect(todayIn(BA, new Date('2030-01-07T02:59:00Z'))).toBe('2030-01-06');
    expect(todayIn(BA, new Date('2030-01-07T03:00:00Z'))).toBe('2030-01-07');
  });
  it('adds days across month ends and labels the zone', () => {
    expect(addDays('2030-01-31', 1)).toBe('2030-02-01');
    expect(addDays('2030-03-01', -1)).toBe('2030-02-28');
    expect(tzLabel(BA, new Date('2030-01-07T12:00:00Z'))).toBe('America/Argentina/Buenos Aires (UTC−03:00)');
  });
});
