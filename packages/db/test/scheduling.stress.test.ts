import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { isDomainError } from '@turnoflow/domain';
import { SchedulingService } from '../src/index.ts';
import { NOW, at, book, createWorld, ctxFor, makePool } from './fixtures.ts';

// RNF-004: 0 incompatible confirmed bookings in 10,000 simulated concurrent attempts. Run with `npm run test:stress`.
let pool: Pool;
beforeAll(() => { pool = makePool(40); });
afterAll(async () => { await pool.end(); });

describe.skipIf(!process.env.STRESS)('RNF-004 stress', () => {
  it('10,000 concurrent attempts over 100 slots confirm exactly 100 appointments', async () => {
    const svc = new SchedulingService(pool);
    const w = await createWorld(pool, { patients: 100 });
    const { slots } = await svc.searchAvailability(ctxFor(w), {
      clinicId: w.clinicId, serviceId: w.serviceId, from: at('2030-01-07T00:00:00Z'), to: at('2030-02-06T00:00:00Z'),
    });
    const targets = slots.slice(0, 100).map((s) => s.startsAt);
    expect(targets).toHaveLength(100);

    let ok = 0; let conflicts = 0; const unexpected: unknown[] = [];
    for (let batch = 0; batch < 10; batch++) {
      await Promise.all(Array.from({ length: 1000 }, (_, i) => {
        const n = batch * 1000 + i;
        return book(svc, w, w.patientIds[n % 100]!, targets[n % 100]!).then(
          () => { ok++; },
          (e: unknown) => { if (isDomainError(e, 'SLOT_TAKEN')) conflicts++; else unexpected.push(e); });
      }));
    }
    expect(unexpected).toEqual([]);
    expect(ok).toBe(100);
    expect(conflicts).toBe(9900);
    const dup = await pool.query(
      `SELECT count(*) FROM (SELECT start_at FROM appointments WHERE tenant_id = $1 AND status = 'CONFIRMED' GROUP BY start_at HAVING count(*) > 1) d`, [w.tenantId]);
    expect(Number(dup.rows[0].count)).toBe(0);
    void NOW;
  }, 300_000);
});
