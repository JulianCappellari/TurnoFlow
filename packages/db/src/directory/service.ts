import { DomainError } from '@turnoflow/domain';
import type { Pool } from 'pg';
import { audit, type Ctx } from '../scheduling/service.ts';
import { isUuid, one, pgCode, rows } from '../tx.ts';

const DAY_MS = 86_400_000;
const E164 = /^\+[1-9][0-9]{6,14}$/;

export interface ClinicSummary { id: string; name: string; timezone: string }
export interface Catalog {
  clinic: ClinicSummary;
  professionals: { id: string; name: string; specialty: string | null; serviceIds: string[] }[];
  services: { id: string; name: string; durationMin: number }[];
}
export interface AgendaItem {
  id: string; professionalId: string; serviceId: string; serviceName: string; patientId: string;
  patientName: string; patientPhone: string; startsAt: Date; endsAt: Date; status: string;
}
export interface PatientRow { id: string; fullName: string; phone: string }

const needUuid = (v: unknown, what: string): string => {
  if (!isUuid(v)) throw new DomainError('NOT_FOUND', `${what} not found`);
  return v;
};

/** RF-011: conservative normalization. Accepts spaces, dashes and parentheses; never guesses a country code. */
export function normalizePhoneE164(raw: string): string {
  const cleaned = raw.trim().replace(/[\s().-]/g, '');
  if (!E164.test(cleaned)) throw new DomainError('VALIDATION', 'Phone must be in international format, e.g. +5491122334455');
  return cleaned;
}

/** Read models and minimal patient directory used by the reception panel. Every query is tenant-scoped. */
export class DirectoryService {
  constructor(private readonly pool: Pool) {}

  async listClinics(ctx: Ctx): Promise<ClinicSummary[]> {
    return rows<ClinicSummary>(this.pool, `SELECT id, name, timezone FROM clinics WHERE tenant_id = $1 AND status = 'ACTIVE' ORDER BY name`, [ctx.tenantId]);
  }

  async getCatalog(ctx: Ctx, clinicIdRaw: string): Promise<Catalog> {
    const clinicId = needUuid(clinicIdRaw, 'Clinic');
    const clinic = await one<ClinicSummary>(this.pool, `SELECT id, name, timezone FROM clinics WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'`, [ctx.tenantId, clinicId]);
    if (!clinic) throw new DomainError('NOT_FOUND', 'Clinic not found');
    const profs = await rows<{ id: string; name: string; specialty: string | null }>(
      this.pool, 'SELECT id, name, specialty FROM professionals WHERE tenant_id = $1 AND clinic_id = $2 AND active ORDER BY name', [ctx.tenantId, clinicId]);
    const links = await rows<{ professional_id: string; service_id: string }>(
      this.pool, `SELECT ps.professional_id, ps.service_id FROM professional_services ps
                   JOIN professionals p ON p.tenant_id = ps.tenant_id AND p.id = ps.professional_id
                  WHERE ps.tenant_id = $1 AND p.clinic_id = $2`, [ctx.tenantId, clinicId]);
    const services = await rows<{ id: string; name: string; duration_min: number }>(
      this.pool, 'SELECT id, name, duration_min FROM services WHERE tenant_id = $1 AND active ORDER BY name', [ctx.tenantId]);
    return {
      clinic,
      professionals: profs.map((p) => ({ ...p, serviceIds: links.filter((l) => l.professional_id === p.id).map((l) => l.service_id) })),
      services: services.map((s) => ({ id: s.id, name: s.name, durationMin: s.duration_min })),
    };
  }

  /** Agenda for a window of at most 8 days. Contains patient contact data: callers must hold `appointment.read`. */
  async listAgenda(ctx: Ctx, input: { clinicId: string; from: Date; to: Date; professionalId?: string }): Promise<AgendaItem[]> {
    const clinicId = needUuid(input.clinicId, 'Clinic');
    if (!(input.from < input.to)) throw new DomainError('VALIDATION', 'from must be before to');
    if (input.to.getTime() - input.from.getTime() > 8 * DAY_MS) throw new DomainError('VALIDATION', 'Range cannot exceed 8 days');
    const clinic = await one(this.pool, 'SELECT 1 FROM clinics WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, clinicId]);
    if (!clinic) throw new DomainError('NOT_FOUND', 'Clinic not found');
    const r = await rows<{
      id: string; professional_id: string; service_id: string; service_name: string; patient_id: string;
      full_name: string; phone_e164: string; start_at: Date; end_at: Date; status: string;
    }>(
      this.pool,
      `SELECT a.id, a.professional_id, a.service_id, s.name AS service_name, a.patient_id, p.full_name, p.phone_e164,
              a.start_at, a.end_at, a.status
         FROM appointments a
         JOIN patients p ON p.tenant_id = a.tenant_id AND p.id = a.patient_id
         JOIN services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id
        WHERE a.tenant_id = $1 AND a.clinic_id = $2 AND a.start_at >= $3 AND a.start_at < $4
          AND a.status NOT IN ('EXPIRED', 'REQUESTED', 'HELD', 'PENDING_PAYMENT')
          AND ($5::uuid IS NULL OR a.professional_id = $5)
        ORDER BY a.start_at, a.id LIMIT 500`,
      [ctx.tenantId, clinicId, input.from, input.to, input.professionalId ? needUuid(input.professionalId, 'Professional') : null]);
    return r.map((x) => ({
      id: x.id, professionalId: x.professional_id, serviceId: x.service_id, serviceName: x.service_name, patientId: x.patient_id,
      patientName: x.full_name, patientPhone: x.phone_e164, startsAt: x.start_at, endsAt: x.end_at, status: x.status,
    }));
  }

  async searchPatients(ctx: Ctx, query: string, limit = 20): Promise<PatientRow[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const esc = q.replace(/[\\%_]/g, (m) => `\\${m}`);
    const digits = q.replace(/\D/g, '');
    return (await rows<{ id: string; full_name: string; phone_e164: string }>(
      this.pool,
      `SELECT id, full_name, phone_e164 FROM patients
        WHERE tenant_id = $1 AND (full_name ILIKE $2 OR ($3 <> '' AND phone_e164 LIKE $4))
        ORDER BY full_name LIMIT $5`,
      [ctx.tenantId, `%${esc}%`, digits.length >= 3 ? digits : '', `%${digits}%`, Math.min(limit, 50)],
    )).map((r) => ({ id: r.id, fullName: r.full_name, phone: r.phone_e164 }));
  }

  async createPatient(ctx: Ctx, input: { fullName: string; phone: string }): Promise<PatientRow> {
    const fullName = input.fullName.trim().replace(/\s+/g, ' ');
    if (fullName.length < 2 || fullName.length > 120) throw new DomainError('VALIDATION', 'Name must have 2-120 characters');
    const phone = normalizePhoneE164(input.phone);
    try {
      const r = await this.pool.query<{ id: string }>(
        'INSERT INTO patients (tenant_id, full_name, phone_e164) VALUES ($1,$2,$3) RETURNING id', [ctx.tenantId, fullName, phone]);
      const id = r.rows[0]!.id;
      await audit(this.pool, ctx, { action: 'patient.created', objectType: 'patient', objectId: id }); // no personal data in the trail
      return { id, fullName, phone };
    } catch (e) {
      if (pgCode(e) === '23505') throw new DomainError('CONFLICT', 'A patient with that phone already exists'); // RF-011: conservative dedup
      throw e;
    }
  }
}
