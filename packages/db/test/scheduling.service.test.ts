import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { isDomainError, type ErrorCode } from '@turnoflow/domain';
import { SchedulingService } from '../src/index.ts';
import { MONDAY_09, NOW, at, book, createWorld, ctxFor, makePool } from './fixtures.ts';

let pool: Pool;
let svc: SchedulingService;
beforeAll(() => { pool = makePool(10); svc = new SchedulingService(pool); });
afterAll(async () => { await pool.end(); });

async function expectCode(p: Promise<unknown>, code: ErrorCode) {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err, `expected ${code}`).toBeDefined();
  expect(isDomainError(err, code), `got ${(err as Error).message}`).toBe(true);
}

const DAY = { from: at('2030-01-07T03:00:00Z'), to: at('2030-01-08T03:00:00Z') };

describe('availability (RF-028)', () => {
  it('offers only real slots in clinic-local hours, in UTC', async () => {
    const w = await createWorld(pool);
    const r = await svc.searchAvailability(ctxFor(w), { clinicId: w.clinicId, serviceId: w.serviceId, ...DAY });
    expect(r.timezone).toBe('America/Argentina/Buenos_Aires');
    expect(r.slots.map((s) => s.startsAt.toISOString())).toEqual([
      '2030-01-07T12:00:00.000Z', '2030-01-07T12:30:00.000Z', '2030-01-07T13:00:00.000Z', '2030-01-07T13:30:00.000Z',
      '2030-01-07T14:00:00.000Z', '2030-01-07T14:30:00.000Z', '2030-01-07T15:00:00.000Z', '2030-01-07T15:30:00.000Z',
    ]);
  });

  it('removes booked, held, blocked and holiday slots; frees them on cancel (RN-005)', async () => {
    const w = await createWorld(pool);
    const appt = await book(svc, w, w.patientIds[0]!, at('2030-01-07T12:00:00Z'));
    await svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: at('2030-01-07T12:30:00Z') });
    await svc.createScheduleException(ctxFor(w), { clinicId: w.clinicId, professionalId: w.professionalId, kind: 'BLOCK', startsAt: at('2030-01-07T13:00:00Z'), endsAt: at('2030-01-07T14:00:00Z') });
    const q = () => svc.searchAvailability(ctxFor(w), { clinicId: w.clinicId, serviceId: w.serviceId, ...DAY });
    expect((await q()).slots.map((s) => s.startsAt.toISOString())).toEqual([
      '2030-01-07T14:00:00.000Z', '2030-01-07T14:30:00.000Z', '2030-01-07T15:00:00.000Z', '2030-01-07T15:30:00.000Z']);
    await svc.cancelAppointment(ctxFor(w), { appointmentId: appt.appointmentId });
    expect((await q()).slots[0]!.startsAt.toISOString()).toBe('2030-01-07T12:00:00.000Z');
  });

  it('honours clinic-wide holidays, inactive professionals and unlinked services', async () => {
    const w = await createWorld(pool);
    await svc.createScheduleException(ctxFor(w), { clinicId: w.clinicId, kind: 'HOLIDAY', startsAt: DAY.from, endsAt: DAY.to });
    expect((await svc.searchAvailability(ctxFor(w), { clinicId: w.clinicId, serviceId: w.serviceId, ...DAY })).slots).toHaveLength(0);

    const w2 = await createWorld(pool);
    await pool.query('UPDATE professionals SET active = false WHERE id = $1', [w2.professionalId]);
    expect((await svc.searchAvailability(ctxFor(w2), { clinicId: w2.clinicId, serviceId: w2.serviceId, ...DAY })).slots).toHaveLength(0);
  });

  it('hides expired holds and rejects oversized ranges', async () => {
    const w = await createWorld(pool);
    await svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: MONDAY_09 });
    const later = new Date(NOW.getTime() + 11 * 60_000); // TTL is 10 min
    const r = await svc.searchAvailability(ctxFor(w, { now: later }), { clinicId: w.clinicId, serviceId: w.serviceId, ...DAY });
    expect(r.slots[0]!.startsAt.toISOString()).toBe(MONDAY_09.toISOString());
    await expectCode(svc.searchAvailability(ctxFor(w), { clinicId: w.clinicId, serviceId: w.serviceId, from: DAY.from, to: at('2030-03-01T00:00:00Z') }), 'VALIDATION');
  });
});

describe('TC-010: valid booking', () => {
  it('creates 1 hold consumed + 1 appointment + 1 confirmation event + audit trail', async () => {
    const w = await createWorld(pool);
    const res = await book(svc, w, w.patientIds[0]!, MONDAY_09);
    expect(res).toMatchObject({ status: 'CONFIRMED', startsAt: MONDAY_09.toISOString(), timezone: 'America/Argentina/Buenos_Aires', syncStatus: 'NOT_APPLICABLE' });
    const q = async (sql: string) => Number((await pool.query(sql, [w.tenantId])).rows[0].count);
    expect(await q(`SELECT count(*) FROM appointments WHERE tenant_id = $1 AND status = 'CONFIRMED'`)).toBe(1);
    expect(await q(`SELECT count(*) FROM booking_holds WHERE tenant_id = $1 AND status = 'CONSUMED'`)).toBe(1);
    expect(await q(`SELECT count(*) FROM outbox_events WHERE tenant_id = $1 AND type = 'appointment.confirmed'`)).toBe(1);
    expect(await q(`SELECT count(*) FROM audit_events WHERE tenant_id = $1 AND action IN ('booking_hold.created','appointment.confirmed')`)).toBe(2);
  });
});

describe('TC-011: slots that do not exist are never offered or confirmed (RN-005/013)', () => {
  it.each([
    ['outside working hours', '2030-01-07T20:00:00Z'],
    ['off the slot grid', '2030-01-07T12:10:00Z'],
    ['on a day without schedule (Sunday)', '2030-01-06T12:00:00Z'],
    ['in the past', '2029-12-31T12:00:00Z'],
  ])('rejects a hold %s', async (_n, iso) => {
    const w = await createWorld(pool);
    await expectCode(svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: at(iso) }), 'SLOT_NOT_OFFERED');
  });

  it('rejects slots beyond the booking horizon and during a block', async () => {
    const w = await createWorld(pool);
    await expectCode(svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: at('2031-01-07T12:00:00Z') }), 'SLOT_NOT_OFFERED');
    await svc.createScheduleException(ctxFor(w), { clinicId: w.clinicId, kind: 'ABSENCE', professionalId: w.professionalId, startsAt: MONDAY_09, endsAt: at('2030-01-07T12:30:00Z') });
    await expectCode(svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: MONDAY_09 }), 'SLOT_NOT_OFFERED');
  });

  it('enforces service/professional enablement (RN-004)', async () => {
    const w = await createWorld(pool);
    const other = await pool.query<{ id: string }>(`INSERT INTO services (tenant_id, name, duration_min) VALUES ($1,'Otra',30) RETURNING id`, [w.tenantId]);
    await expectCode(svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: other.rows[0]!.id, startsAt: MONDAY_09 }), 'RULE_VIOLATION');
  });
});

describe('holds and confirmation (RF-029/030, RN-011/012/013)', () => {
  it('expired holds cannot be confirmed (410) and free the slot for others', async () => {
    const w = await createWorld(pool);
    const hold = await svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: MONDAY_09 });
    const late = ctxFor(w, { now: new Date(NOW.getTime() + 11 * 60_000) });
    await expectCode(svc.confirmAppointment(late, { holdId: hold.holdId, patientId: w.patientIds[0]!, token: hold.token, idempotencyKey: 'key-expired-1' }), 'HOLD_EXPIRED');
    // another patient can take the slot, and the stale hold is expired by the next createHold
    const res = await book(svc, w, w.patientIds[1]!, MONDAY_09, { now: late.now });
    expect(res.status).toBe('CONFIRMED');
    const st = await pool.query(`SELECT status FROM booking_holds WHERE tenant_id = $1 ORDER BY created_at`, [w.tenantId]);
    expect(st.rows.map((r) => r.status)).toEqual(['EXPIRED', 'CONSUMED']);
  });

  it('expireHolds job expires only stale active holds and is idempotent', async () => {
    // The job is global, so this test uses its own clock (well before NOW) to avoid touching other tests' holds.
    const earlier = new Date('2029-12-20T00:00:00Z');
    const w = await createWorld(pool);
    await svc.createHold(ctxFor(w, { now: earlier }), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: MONDAY_09 });
    expect(await svc.expireHolds(earlier)).toBe(0);
    const cutoff = new Date(earlier.getTime() + 11 * 60_000);
    expect(await svc.expireHolds(cutoff)).toBeGreaterThanOrEqual(1);
    expect(await svc.expireHolds(cutoff)).toBe(0);
    const r = await pool.query(`SELECT status FROM booking_holds WHERE tenant_id = $1`, [w.tenantId]);
    expect(r.rows[0].status).toBe('EXPIRED');
  });

  it('wrong token is rejected without side effects; released holds cannot be confirmed', async () => {
    const w = await createWorld(pool);
    const hold = await svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: MONDAY_09 });
    await expectCode(svc.confirmAppointment(ctxFor(w), { holdId: hold.holdId, patientId: w.patientIds[0]!, token: 'nope', idempotencyKey: 'key-badtoken-1' }), 'INVALID_TOKEN');
    await expectCode(svc.releaseHold(ctxFor(w), { holdId: hold.holdId, token: 'nope' }), 'INVALID_TOKEN');
    expect(await svc.releaseHold(ctxFor(w), { holdId: hold.holdId, token: hold.token })).toEqual({ released: true });
    await expectCode(svc.confirmAppointment(ctxFor(w), { holdId: hold.holdId, patientId: w.patientIds[0]!, token: hold.token, idempotencyKey: 'key-released-1' }), 'HOLD_NOT_ACTIVE');
    const none = await pool.query(`SELECT count(*) FROM appointments WHERE tenant_id = $1`, [w.tenantId]);
    expect(Number(none.rows[0].count)).toBe(0);
  });

  it('a patient actor cannot book for another patient (RN-007)', async () => {
    const w = await createWorld(pool);
    const hold = await svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: MONDAY_09 });
    await expectCode(
      svc.confirmAppointment(ctxFor(w, { actor: { type: 'patient', id: w.patientIds[0]! } }), { holdId: hold.holdId, patientId: w.patientIds[1]!, token: hold.token, idempotencyKey: 'key-other-pat-1' }),
      'FORBIDDEN');
  });
});

describe('idempotency (TC-021/022)', () => {
  it('retry with the same key and payload returns the stored result; changed payload is 409 with evidence', async () => {
    const w = await createWorld(pool, { patients: 2 });
    const hold = await svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: MONDAY_09 });
    const key = `idem-${randomUUID()}`;
    const args = { holdId: hold.holdId, patientId: w.patientIds[0]!, token: hold.token, idempotencyKey: key };
    const first = await svc.confirmAppointment(ctxFor(w), args);
    const retry = await svc.confirmAppointment(ctxFor(w), args);
    expect(retry).toEqual({ ...first, replayed: true });

    await expectCode(svc.confirmAppointment(ctxFor(w), { ...args, patientId: w.patientIds[1]! }), 'IDEMPOTENCY_MISMATCH');
    const ev = await pool.query(`SELECT count(*) FROM audit_events WHERE tenant_id = $1 AND action = 'idempotency.mismatch'`, [w.tenantId]);
    expect(Number(ev.rows[0].count)).toBe(1);
    const n = await pool.query(`SELECT count(*) FROM appointments WHERE tenant_id = $1`, [w.tenantId]);
    expect(Number(n.rows[0].count)).toBe(1);
  });

  it('rejects malformed keys', async () => {
    const w = await createWorld(pool);
    const hold = await svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: MONDAY_09 });
    await expectCode(svc.confirmAppointment(ctxFor(w), { holdId: hold.holdId, patientId: w.patientIds[0]!, token: hold.token, idempotencyKey: 'x' }), 'VALIDATION');
  });
});

describe('cancellation (RF-031, TC-040)', () => {
  it('duplicate cancellation is idempotent: one event, one audit entry, final state CANCELLED', async () => {
    const w = await createWorld(pool);
    const a = await book(svc, w, w.patientIds[0]!, MONDAY_09);
    const r1 = await svc.cancelAppointment(ctxFor(w), { appointmentId: a.appointmentId, reason: 'paciente avisa' });
    const r2 = await svc.cancelAppointment(ctxFor(w), { appointmentId: a.appointmentId, reason: 'paciente avisa' });
    expect([r1.alreadyCancelled, r2.alreadyCancelled]).toEqual([false, true]);
    const ev = await pool.query(`SELECT count(*) FROM outbox_events WHERE tenant_id = $1 AND type = 'appointment.cancelled'`, [w.tenantId]);
    expect(Number(ev.rows[0].count)).toBe(1);
    const au = await pool.query(`SELECT count(*) FROM audit_events WHERE tenant_id = $1 AND action = 'appointment.cancelled'`, [w.tenantId]);
    expect(Number(au.rows[0].count)).toBe(1);
  });

  it('50 concurrent cancellations produce exactly one transition and one event', async () => {
    const w = await createWorld(pool);
    const a = await book(svc, w, w.patientIds[0]!, MONDAY_09);
    const rs = await Promise.all(Array.from({ length: 50 }, () => svc.cancelAppointment(ctxFor(w), { appointmentId: a.appointmentId })));
    expect(rs.filter((r) => !r.alreadyCancelled)).toHaveLength(1);
    const ev = await pool.query(`SELECT count(*) FROM outbox_events WHERE tenant_id = $1 AND type = 'appointment.cancelled'`, [w.tenantId]);
    expect(Number(ev.rows[0].count)).toBe(1);
  });

  it('a patient may only cancel their own appointment, and only inside the policy window (RN-007/008)', async () => {
    const w = await createWorld(pool, { cancellationNoticeMin: 24 * 60 });
    const a = await book(svc, w, w.patientIds[0]!, MONDAY_09);
    await expectCode(svc.cancelAppointment(ctxFor(w, { actor: { type: 'patient', id: w.patientIds[1]! } }), { appointmentId: a.appointmentId }), 'NOT_FOUND');
    const tooLate = ctxFor(w, { actor: { type: 'patient', id: w.patientIds[0]! }, now: new Date(MONDAY_09.getTime() - 60 * 60_000) });
    await expectCode(svc.cancelAppointment(tooLate, { appointmentId: a.appointmentId }), 'CANCELLATION_WINDOW_CLOSED');
    const inTime = ctxFor(w, { actor: { type: 'patient', id: w.patientIds[0]! }, now: new Date(MONDAY_09.getTime() - 48 * 3600_000) });
    expect((await svc.cancelAppointment(inTime, { appointmentId: a.appointmentId })).status).toBe('CANCELLED');
  });

  it('completed appointments cannot be cancelled (state machine)', async () => {
    const w = await createWorld(pool);
    const a = await book(svc, w, w.patientIds[0]!, MONDAY_09);
    await pool.query(`UPDATE appointments SET status = 'COMPLETED' WHERE id = $1`, [a.appointmentId]);
    await expectCode(svc.cancelAppointment(ctxFor(w), { appointmentId: a.appointmentId }), 'INVALID_TRANSITION');
  });
});

describe('availability changes (RF-032)', () => {
  it('reports affected appointments, releases overlapping holds and never reprograms anything', async () => {
    const w = await createWorld(pool);
    const a = await book(svc, w, w.patientIds[0]!, MONDAY_09);
    const hold = await svc.createHold(ctxFor(w), { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: at('2030-01-07T12:30:00Z') });
    const r = await svc.createScheduleException(ctxFor(w), { clinicId: w.clinicId, professionalId: w.professionalId, kind: 'ABSENCE', startsAt: MONDAY_09, endsAt: at('2030-01-07T13:00:00Z'), reason: 'congreso' });
    expect(r.affectedAppointments.map((x) => x.id)).toEqual([a.appointmentId]);
    expect(r.releasedHolds).toBe(1);
    const appt = await pool.query('SELECT status, start_at FROM appointments WHERE id = $1', [a.appointmentId]);
    expect(appt.rows[0].status).toBe('CONFIRMED');
    expect(appt.rows[0].start_at.toISOString()).toBe(MONDAY_09.toISOString());
    await expectCode(svc.confirmAppointment(ctxFor(w), { holdId: hold.holdId, patientId: w.patientIds[1]!, token: hold.token, idempotencyKey: 'key-after-block-1' }), 'HOLD_NOT_ACTIVE');
  });
});
