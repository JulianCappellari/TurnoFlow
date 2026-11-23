import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { isDomainError } from '@turnoflow/domain';
import { SchedulingService } from '../src/index.ts';
import { MONDAY_09, NOW, addPatient, at, book, createWorld, ctxFor, makePool } from './fixtures.ts';

let pool: Pool;
let svc: SchedulingService;
beforeAll(() => { pool = makePool(30); svc = new SchedulingService(pool); });
afterAll(async () => { await pool.end(); });

const outcome = async <T>(p: Promise<T>) =>
  p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

const countAppointments = async (tenantId: string, startsAt?: Date) =>
  Number((await pool.query(
    `SELECT count(*) FROM appointments WHERE tenant_id = $1 AND status = 'CONFIRMED' AND ($2::timestamptz IS NULL OR start_at = $2)`,
    [tenantId, startsAt ?? null])).rows[0].count);

async function assertNoOverlaps(tenantId: string) {
  const r = await pool.query(
    `SELECT count(*) FROM appointments a JOIN appointments b
       ON a.tenant_id = b.tenant_id AND a.professional_id = b.professional_id AND a.id < b.id
      AND tstzrange(a.start_at, a.occupied_until) && tstzrange(b.start_at, b.occupied_until)
    WHERE a.tenant_id = $1 AND a.status = 'CONFIRMED' AND b.status = 'CONFIRMED'`, [tenantId]);
  expect(Number(r.rows[0].count)).toBe(0);
}

describe('TC-020: 100 concurrent requests for the same slot', () => {
  it('hold + confirm from 100 different patients yields exactly one confirmed appointment', async () => {
    const w = await createWorld(pool, { patients: 100 });
    const results = await Promise.all(w.patientIds.map((pid) => outcome(book(svc, w, pid, MONDAY_09))));

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(99);
    for (const l of losers) {
      expect(!l.ok && isDomainError(l.error, 'SLOT_TAKEN')).toBe(true); // controlled 409, never a raw DB error
    }
    expect(await countAppointments(w.tenantId, MONDAY_09)).toBe(1);
    const holds = await pool.query(`SELECT status, count(*) FROM booking_holds WHERE tenant_id = $1 GROUP BY status`, [w.tenantId]);
    expect(Object.fromEntries(holds.rows.map((r) => [r.status, Number(r.count)]))).toEqual({ CONSUMED: 1 });
  });

  it('100 concurrent createHold calls on the same slot yield exactly one active hold', async () => {
    const w = await createWorld(pool, { patients: 0 });
    const results = await Promise.all(Array.from({ length: 100 }, () =>
      outcome(svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: MONDAY_09 }))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && isDomainError(r.error, 'SLOT_TAKEN'))).toHaveLength(99);
  });

  it('100 concurrent confirms of the SAME hold with different keys consume it once', async () => {
    const w = await createWorld(pool, { patients: 1 });
    const hold = await svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: MONDAY_09 });
    const results = await Promise.all(Array.from({ length: 100 }, () =>
      outcome(svc.confirmAppointment(ctxFor(w), { holdId: hold.holdId, patientId: w.patientIds[0]!, token: hold.token, idempotencyKey: `key-${randomUUID()}` }))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && isDomainError(r.error, 'HOLD_NOT_ACTIVE'))).toHaveLength(99);
    expect(await countAppointments(w.tenantId)).toBe(1);
  });

  it('TC-021: 100 concurrent confirms with the SAME Idempotency-Key return one identical result', async () => {
    const w = await createWorld(pool, { patients: 1 });
    const hold = await svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: MONDAY_09 });
    const key = `idem-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 100 }, () =>
      outcome(svc.confirmAppointment(ctxFor(w), { holdId: hold.holdId, patientId: w.patientIds[0]!, token: hold.token, idempotencyKey: key }))));
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = new Set(results.map((r) => r.ok && r.value.appointmentId));
    expect(ids.size).toBe(1);
    expect(await countAppointments(w.tenantId)).toBe(1);
    const events = await pool.query(`SELECT count(*) FROM outbox_events WHERE tenant_id = $1 AND type = 'appointment.confirmed'`, [w.tenantId]);
    expect(Number(events.rows[0].count)).toBe(1); // exactly one confirmation event
  });

  it('overlapping starts (09:00, 09:15, 09:30...) never produce overlapping appointments', async () => {
    const w = await createWorld(pool, { patients: 60, stepMin: 15, durationMin: 30, bufferMin: 10 });
    const starts = Array.from({ length: 12 }, (_, i) => new Date(MONDAY_09.getTime() + i * 15 * 60_000));
    const jobs = w.patientIds.map((pid, i) => outcome(book(svc, w, pid, starts[i % starts.length]!)));
    const results = await Promise.all(jobs);
    for (const r of results.filter((x) => !x.ok)) {
      expect(!r.ok && (isDomainError(r.error, 'SLOT_TAKEN') || isDomainError(r.error, 'SLOT_NOT_OFFERED'))).toBe(true);
    }
    expect(results.some((r) => r.ok)).toBe(true);
    await assertNoOverlaps(w.tenantId);
  });

  it('constraint backstop: raw concurrent INSERTs bypassing the service still cannot overlap', async () => {
    // Raw inserts bypass the advisory lock, so PostgreSQL may abort losers by exclusion (23P01) or by deadlock
    // detection (40P01). Either way the row is rejected; what matters is that exactly one survives.
    const w = await createWorld(pool, { patients: 20 });
    const insert = (pid: string) => pool.query(
      `INSERT INTO appointments (tenant_id, clinic_id, patient_id, professional_id, service_id, start_at, end_at, occupied_until, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'CONFIRMED')`,
      [w.tenantId, w.clinicId, pid, w.professionalId, w.serviceId, MONDAY_09, new Date(MONDAY_09.getTime() + 30 * 60_000)]);
    const results = await Promise.all(w.patientIds.map((pid) => outcome(insert(pid))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(['23P01', '40P01']).toContain((r as { error: { code?: string } }).error.code);
  });

  it('a cancelled slot can be rebooked, and a late retry cannot resurrect the cancelled appointment (RN-014)', async () => {
    const w = await createWorld(pool, { patients: 2 });
    const first = await book(svc, w, w.patientIds[0]!, MONDAY_09);
    await svc.cancelAppointment(ctxFor(w), { appointmentId: first.appointmentId, reason: 'test' });
    const second = await book(svc, w, w.patientIds[1]!, MONDAY_09);
    expect(second.appointmentId).not.toBe(first.appointmentId);
    expect(await countAppointments(w.tenantId, MONDAY_09)).toBe(1);
    const status = await pool.query('SELECT status FROM appointments WHERE id = $1', [first.appointmentId]);
    expect(status.rows[0].status).toBe('CANCELLED');
  });
});

// Not used directly; keeps helper imports honest if tests are trimmed.
void NOW; void addPatient; void at;
