import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { SchedulingService } from '../src/index.ts';
import { MONDAY_09, at, book, createWorld, ctxFor, makePool } from './fixtures.ts';
import { isDomainError } from '@turnoflow/domain';

let pool: Pool;
let svc: SchedulingService;
beforeAll(() => { pool = makePool(10); svc = new SchedulingService(pool); });
afterAll(async () => { await pool.end(); });

const pgCode = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: { code?: string }) => e))?.code;

describe('schema constraints', () => {
  it('audit_events is append-only (RF-006)', async () => {
    const w = await createWorld(pool);
    await book(svc, w, w.patientIds[0]!, MONDAY_09);
    expect(await pgCode(pool.query('UPDATE audit_events SET action = $1 WHERE tenant_id = $2', ['x', w.tenantId]))).toBe('23000');
    expect(await pgCode(pool.query('DELETE FROM audit_events WHERE tenant_id = $1', [w.tenantId]))).toBe('23000');
    expect(await pgCode(pool.query('TRUNCATE audit_events'))).toBe('23000');
  });

  it('rejects overlapping weekly rules and invalid ranges (RF-002/010)', async () => {
    const w = await createWorld(pool);
    const ins = (d: number, s: number, e: number) => pool.query(
      'INSERT INTO schedules (tenant_id, professional_id, weekday, start_minute, end_minute) VALUES ($1,$2,$3,$4,$5)',
      [w.tenantId, w.professionalId, d, s, e]);
    expect(await pgCode(ins(1, 600, 840))).toBe('23P01'); // overlaps 09:00-13:00
    expect(await pgCode(ins(6, 600, 600))).toBe('23514');
    await expect(ins(6, 540, 780)).resolves.toBeDefined(); // Saturday is free
  });

  it('rejects invalid timezones, durations and phone numbers', async () => {
    const w = await createWorld(pool);
    expect(await pgCode(pool.query(`INSERT INTO clinics (tenant_id, name, timezone) VALUES ($1,'x','Mars/Olympus')`, [w.tenantId]))).toBeDefined();
    expect(await pgCode(pool.query(`INSERT INTO services (tenant_id, name, duration_min) VALUES ($1,'x',0)`, [w.tenantId]))).toBe('23514');
    expect(await pgCode(pool.query(`INSERT INTO patients (tenant_id, full_name, phone_e164) VALUES ($1,'x','1155')`, [w.tenantId]))).toBe('23514');
  });

  it('refuses to delete professionals that have appointments (RF-008)', async () => {
    const w = await createWorld(pool);
    await book(svc, w, w.patientIds[0]!, MONDAY_09);
    expect(await pgCode(pool.query('DELETE FROM professionals WHERE id = $1', [w.professionalId]))).toBe('23503');
  });
});

describe('TC-100: tenant isolation (RN-001, RNF-002)', () => {
  it('tenant B cannot see, confirm, cancel or reference tenant A resources, even knowing their ids', async () => {
    const a = await createWorld(pool);
    const b = await createWorld(pool);
    const appt = await book(svc, a, a.patientIds[0]!, MONDAY_09);
    const hold = await svc.createHold(ctxFor(a), { professionalId: a.professionalId, serviceId: a.serviceId, startsAt: at('2030-01-07T12:30:00Z') });
    const code = async (p: Promise<unknown>) => { const e = await p.then(() => undefined, (x: unknown) => x); return isDomainError(e) ? e.code : String(e); };

    expect(await code(svc.cancelAppointment(ctxFor(b), { appointmentId: appt.appointmentId }))).toBe('NOT_FOUND');
    expect(await code(svc.confirmAppointment(ctxFor(b), { holdId: hold.holdId, patientId: b.patientIds[0]!, token: hold.token, idempotencyKey: 'key-cross-tenant-1' }))).toBe('NOT_FOUND');
    expect(await code(svc.createHold(ctxFor(b), { professionalId: a.professionalId, serviceId: b.serviceId, startsAt: MONDAY_09 }))).toBe('NOT_FOUND');
    expect(await code(svc.searchAvailability(ctxFor(b), { clinicId: a.clinicId, serviceId: a.serviceId, from: at('2030-01-07T03:00:00Z'), to: at('2030-01-08T03:00:00Z') }))).toBe('NOT_FOUND');
    expect(await code(svc.confirmAppointment(ctxFor(a), { holdId: hold.holdId, patientId: b.patientIds[0]!, token: hold.token, idempotencyKey: 'key-cross-patient-1' }))).toBe('NOT_FOUND');

    // A's data is untouched
    const st = await pool.query('SELECT status FROM appointments WHERE id = $1', [appt.appointmentId]);
    expect(st.rows[0].status).toBe('CONFIRMED');
  });

  it('composite foreign keys make cross-tenant references impossible at the database level', async () => {
    const a = await createWorld(pool);
    const b = await createWorld(pool);
    const crossAppointment = pool.query(
      `INSERT INTO appointments (tenant_id, clinic_id, patient_id, professional_id, service_id, start_at, end_at, occupied_until, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'CONFIRMED')`,
      [b.tenantId, b.clinicId, a.patientIds[0], b.professionalId, b.serviceId, MONDAY_09, new Date(MONDAY_09.getTime() + 1800_000)]);
    expect(await pgCode(crossAppointment)).toBe('23503');
    const crossLink = pool.query('INSERT INTO professional_services (tenant_id, professional_id, service_id) VALUES ($1,$2,$3)', [b.tenantId, b.professionalId, a.serviceId]);
    expect(await pgCode(crossLink)).toBe('23503');
  });

  it('same-id uuids from other tenants do not leak through malformed input', async () => {
    const a = await createWorld(pool);
    const code = await svc.cancelAppointment(ctxFor(a), { appointmentId: 'not-a-uuid' }).then(() => 'ok', (e: unknown) => (isDomainError(e) ? e.code : 'raw'));
    expect(code).toBe('NOT_FOUND');
    void randomUUID;
  });
});
