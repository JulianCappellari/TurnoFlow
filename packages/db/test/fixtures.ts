import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { SchedulingService, type Ctx } from '../src/index.ts';
import { baseUrl } from './global-setup.ts';

/** Fixed fake "now" (Tuesday). Slots below live on Monday 2030-01-07, 09:00-13:00 Buenos Aires (UTC-3). */
export const NOW = new Date('2030-01-01T00:00:00Z');
export const MONDAY_09 = new Date('2030-01-07T12:00:00Z');
export const at = (isoUtc: string): Date => new Date(isoUtc);

export function makePool(max = 30): Pool {
  return new Pool({ connectionString: baseUrl(), max });
}

export interface World {
  tenantId: string; clinicId: string; professionalId: string; serviceId: string; patientIds: string[];
}

let phoneSeq = 0;
export async function addPatient(pool: Pool, tenantId: string): Promise<string> {
  phoneSeq += 1;
  // pid keeps numbers distinct across parallel test files; seq keeps them distinct inside this process.
  const phone = `+549${String(process.pid % 100).padStart(2, '0')}${String(phoneSeq).padStart(8, '0')}`;
  const r = await pool.query<{ id: string }>(
    'INSERT INTO patients (tenant_id, full_name, phone_e164) VALUES ($1, $2, $3) RETURNING id',
    [tenantId, `Paciente ${phone.slice(-4)}`, phone]);
  return r.rows[0]!.id;
}

/** One tenant with a Mon-Fri 09:00-13:00 professional offering a 30 min service (synthetic data only). */
export async function createWorld(
  pool: Pool,
  opts: { patients?: number; durationMin?: number; bufferMin?: number; stepMin?: number; cancellationNoticeMin?: number } = {},
): Promise<World> {
  const slug = `t-${randomUUID().slice(0, 12)}`;
  const t = await pool.query<{ id: string }>(`INSERT INTO tenants (slug, name, status) VALUES ($1, $1, 'ACTIVE') RETURNING id`, [slug]);
  const tenantId = t.rows[0]!.id;
  const c = await pool.query<{ id: string }>(
    `INSERT INTO clinics (tenant_id, name, timezone, slot_step_min, cancellation_notice_min)
     VALUES ($1, 'Clinica Test', 'America/Argentina/Buenos_Aires', $2, $3) RETURNING id`,
    [tenantId, opts.stepMin ?? 30, opts.cancellationNoticeMin ?? 0]);
  const clinicId = c.rows[0]!.id;
  const p = await pool.query<{ id: string }>(`INSERT INTO professionals (tenant_id, clinic_id, name) VALUES ($1,$2,'Dra. Test') RETURNING id`, [tenantId, clinicId]);
  const professionalId = p.rows[0]!.id;
  const s = await pool.query<{ id: string }>(
    `INSERT INTO services (tenant_id, name, duration_min, buffer_min) VALUES ($1,'Consulta',$2,$3) RETURNING id`,
    [tenantId, opts.durationMin ?? 30, opts.bufferMin ?? 0]);
  const serviceId = s.rows[0]!.id;
  await pool.query('INSERT INTO professional_services (tenant_id, professional_id, service_id) VALUES ($1,$2,$3)', [tenantId, professionalId, serviceId]);
  for (let weekday = 1; weekday <= 5; weekday++) {
    await pool.query('INSERT INTO schedules (tenant_id, professional_id, weekday, start_minute, end_minute) VALUES ($1,$2,$3,540,780)', [tenantId, professionalId, weekday]);
  }
  const patientIds: string[] = [];
  for (let i = 0; i < (opts.patients ?? 2); i++) patientIds.push(await addPatient(pool, tenantId));
  return { tenantId, clinicId, professionalId, serviceId, patientIds };
}

export const ctxFor = (w: { tenantId: string }, extra: Partial<Ctx> = {}): Ctx => ({
  tenantId: w.tenantId, actor: { type: 'user', id: 'receptionist-1' }, now: NOW, ...extra,
});

/** hold + confirm helper, the way the API does it. */
export async function book(svc: SchedulingService, w: World, patientId: string, startsAt: Date, ctxExtra: Partial<Ctx> = {}) {
  const ctx = ctxFor(w, ctxExtra);
  const hold = await svc.createHold(ctx, { professionalId: w.professionalId, serviceId: w.serviceId, startsAt });
  return svc.confirmAppointment(ctx, {
    holdId: hold.holdId, patientId, token: hold.token, idempotencyKey: `key-${randomUUID()}`,
  });
}
