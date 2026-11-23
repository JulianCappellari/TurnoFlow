import {
  BLOCKING_APPOINTMENT_STATUSES, DomainError, assertAppointmentTransition, generateSlots, isDomainError,
  type Interval, type Slot, type WeeklyRule,
} from '@turnoflow/domain';
import type { Pool, PoolClient } from 'pg';
import {
  canonicalJson, isUuid, lockProfessionalAgenda, mapSlotConflict, newToken, one, rows, safeEqualHex, sha256, withTx,
  type Queryable,
} from '../tx.ts';

const DAY_MS = 86_400_000;
const MAX_SEARCH_DAYS = 31;

export interface Actor {
  type: 'user' | 'patient' | 'agent' | 'system';
  /** user id, or patient id when type is 'patient'. */
  id?: string;
}

/** Everything the API layer must derive from the verified session, never from the request body (spec §12). */
export interface Ctx {
  tenantId: string;
  actor: Actor;
  correlationId?: string;
  /** Injectable clock for tests; defaults to the wall clock. */
  now?: Date;
}

interface ClinicRow {
  id: string; timezone: string; status: string; booking_min_notice_min: number; cancellation_notice_min: number;
  hold_ttl_min: number; slot_step_min: number; max_booking_horizon_days: number;
}
interface ServiceRow { id: string; duration_min: number; buffer_min: number; active: boolean }

export interface AvailableSlot { professionalId: string; startsAt: Date; endsAt: Date; occupiedUntil: Date }
export interface AvailabilityResult { timezone: string; slots: AvailableSlot[] }

export interface HoldResult {
  holdId: string; token: string; expiresAt: Date; startsAt: Date; endsAt: Date; professionalId: string; timezone: string;
}
export interface ConfirmResult {
  appointmentId: string; status: 'CONFIRMED'; startsAt: string; endsAt: string; timezone: string;
  syncStatus: 'NOT_APPLICABLE'; replayed?: boolean;
}
export interface CancelResult { appointmentId: string; status: 'CANCELLED'; alreadyCancelled: boolean }

const notFound = (what: string) => new DomainError('NOT_FOUND', `${what} not found`);
const clock = (ctx: Ctx): Date => ctx.now ?? new Date();

function requireUuid(value: unknown, what: string): string {
  if (!isUuid(value)) throw notFound(what);
  return value;
}
function requireDate(value: unknown, what: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new DomainError('VALIDATION', `${what} must be a valid date`);
  return value;
}

export class SchedulingService {
  constructor(private readonly pool: Pool) {}

  // ------------------------------------------------------------------ availability (RF-028)

  async searchAvailability(
    ctx: Ctx,
    input: { clinicId: string; serviceId: string; from: Date; to: Date; professionalId?: string },
  ): Promise<AvailabilityResult> {
    const clinicId = requireUuid(input.clinicId, 'Clinic');
    const serviceId = requireUuid(input.serviceId, 'Service');
    const from = requireDate(input.from, 'from');
    let to = requireDate(input.to, 'to');
    if (!(from < to)) throw new DomainError('VALIDATION', 'from must be before to');
    if (to.getTime() - from.getTime() > MAX_SEARCH_DAYS * DAY_MS) {
      throw new DomainError('VALIDATION', `Range cannot exceed ${MAX_SEARCH_DAYS} days`);
    }
    const now = clock(ctx);
    const clinic = await one<ClinicRow>(this.pool, 'SELECT * FROM clinics WHERE tenant_id = $1 AND id = $2 AND status = \'ACTIVE\'', [ctx.tenantId, clinicId]);
    if (!clinic) throw notFound('Clinic');
    const service = await one<ServiceRow>(this.pool, 'SELECT * FROM services WHERE tenant_id = $1 AND id = $2 AND active', [ctx.tenantId, serviceId]);
    if (!service) throw notFound('Service');

    const horizonEnd = new Date(now.getTime() + clinic.max_booking_horizon_days * DAY_MS);
    if (to > horizonEnd) to = horizonEnd;

    const professionals = await rows<{ id: string }>(
      this.pool,
      `SELECT p.id FROM professionals p
         JOIN professional_services ps ON ps.tenant_id = p.tenant_id AND ps.professional_id = p.id
        WHERE p.tenant_id = $1 AND p.clinic_id = $2 AND p.active AND ps.service_id = $3
          AND ($4::uuid IS NULL OR p.id = $4)
        ORDER BY p.id`,
      [ctx.tenantId, clinicId, serviceId, input.professionalId ? requireUuid(input.professionalId, 'Professional') : null],
    );
    const ids = professionals.map((p) => p.id);
    if (ids.length === 0 || !(from < to)) return { timezone: clinic.timezone, slots: [] };

    const agenda = await this.loadAgenda(this.pool, ctx.tenantId, clinicId, ids, from, to, now);
    const slots: AvailableSlot[] = [];
    for (const professionalId of ids) {
      const a = agenda.get(professionalId)!;
      for (const s of this.generate(clinic, service, a, from, to, now)) slots.push({ professionalId, ...s });
    }
    slots.sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime() || x.professionalId.localeCompare(y.professionalId));
    return { timezone: clinic.timezone, slots };
  }

  // ------------------------------------------------------------------ holds (RF-029)

  async createHold(ctx: Ctx, input: { professionalId: string; serviceId: string; startsAt: Date }): Promise<HoldResult> {
    const professionalId = requireUuid(input.professionalId, 'Professional');
    const serviceId = requireUuid(input.serviceId, 'Service');
    const startsAt = requireDate(input.startsAt, 'startsAt');
    const now = clock(ctx);

    return withTx(this.pool, async (c) => {
      const prof = await one<{ clinic_id: string; active: boolean }>(
        c, 'SELECT clinic_id, active FROM professionals WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, professionalId]);
      if (!prof || !prof.active) throw notFound('Professional');

      await lockProfessionalAgenda(c, ctx.tenantId, professionalId);

      const clinic = await one<ClinicRow>(c, 'SELECT * FROM clinics WHERE tenant_id = $1 AND id = $2 AND status = \'ACTIVE\'', [ctx.tenantId, prof.clinic_id]);
      if (!clinic) throw notFound('Clinic');
      const service = await one<ServiceRow>(c, 'SELECT * FROM services WHERE tenant_id = $1 AND id = $2 AND active', [ctx.tenantId, serviceId]);
      if (!service) throw notFound('Service');
      const enabled = await one(c, 'SELECT 1 FROM professional_services WHERE tenant_id = $1 AND professional_id = $2 AND service_id = $3', [ctx.tenantId, professionalId, serviceId]);
      if (!enabled) throw new DomainError('RULE_VIOLATION', 'Service is not enabled for this professional'); // RN-004

      // Stale holds must stop blocking before the overlap constraint is evaluated.
      await c.query(
        `UPDATE booking_holds SET status = 'EXPIRED'
          WHERE tenant_id = $1 AND professional_id = $2 AND status = 'ACTIVE' AND expires_at <= $3`,
        [ctx.tenantId, professionalId, now],
      );

      if (startsAt.getTime() >= now.getTime() + clinic.max_booking_horizon_days * DAY_MS) {
        throw new DomainError('SLOT_NOT_OFFERED', 'Slot is beyond the booking horizon');
      }
      const to = new Date(startsAt.getTime() + 1000);
      const agenda = (await this.loadAgenda(c, ctx.tenantId, clinic.id, [professionalId], startsAt, to, now)).get(professionalId)!;
      // The requested start must be an exact grid slot allowed by the rules (RN-005)...
      const offeredByRules = this.generate(clinic, service, { ...agenda, busy: [] }, startsAt, to, now)
        .find((s) => s.startsAt.getTime() === startsAt.getTime());
      if (!offeredByRules) throw new DomainError('SLOT_NOT_OFFERED', 'That time is not an available slot');
      // ...and still free (RN-010).
      const free = this.generate(clinic, service, agenda, startsAt, to, now).find((s) => s.startsAt.getTime() === startsAt.getTime());
      if (!free) throw new DomainError('SLOT_TAKEN', 'The slot is no longer available');

      const token = newToken();
      const expiresAt = new Date(now.getTime() + clinic.hold_ttl_min * 60_000);
      let holdId: string;
      try {
        const inserted = await c.query<{ id: string }>(
          `INSERT INTO booking_holds
             (tenant_id, clinic_id, professional_id, service_id, start_at, end_at, occupied_until, slot_key,
              status, expires_at, token_hash, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,$10,$11,$12) RETURNING id`,
          [ctx.tenantId, clinic.id, professionalId, serviceId, free.startsAt, free.endsAt, free.occupiedUntil,
            `${professionalId}:${free.startsAt.toISOString()}`, expiresAt, sha256(token), actorRef(ctx), now],
        );
        holdId = inserted.rows[0]!.id;
      } catch (e) {
        mapSlotConflict(e);
      }
      await audit(c, ctx, { action: 'booking_hold.created', objectType: 'booking_hold', objectId: holdId });
      return { holdId, token, expiresAt, startsAt: free.startsAt, endsAt: free.endsAt, professionalId, timezone: clinic.timezone };
    });
  }

  async releaseHold(ctx: Ctx, input: { holdId: string; token: string }): Promise<{ released: boolean }> {
    const holdId = requireUuid(input.holdId, 'Hold');
    return withTx(this.pool, async (c) => {
      const hold = await one<{ professional_id: string }>(c, 'SELECT professional_id FROM booking_holds WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, holdId]);
      if (!hold) throw notFound('Hold');
      await lockProfessionalAgenda(c, ctx.tenantId, hold.professional_id);
      const h = await one<{ status: string; token_hash: string }>(c, 'SELECT status, token_hash FROM booking_holds WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [ctx.tenantId, holdId]);
      if (!h || !safeEqualHex(sha256(input.token ?? ''), h.token_hash)) throw new DomainError('INVALID_TOKEN', 'Invalid confirmation token');
      if (h.status !== 'ACTIVE') return { released: false };
      await c.query(`UPDATE booking_holds SET status = 'RELEASED' WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, holdId]);
      await audit(c, ctx, { action: 'booking_hold.released', objectType: 'booking_hold', objectId: holdId });
      return { released: true };
    });
  }

  /** RF-051: idempotent expiry job, safe to run from many workers at once. Returns how many holds expired. */
  async expireHolds(now: Date = new Date()): Promise<number> {
    const r = await this.pool.query(
      `UPDATE booking_holds SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND expires_at <= $1`, [now]);
    return r.rowCount ?? 0;
  }

  // ------------------------------------------------------------------ confirm (RF-030, RN-012/013)

  async confirmAppointment(
    ctx: Ctx,
    input: { holdId: string; patientId: string; token: string; idempotencyKey: string },
  ): Promise<ConfirmResult> {
    const holdId = requireUuid(input.holdId, 'Hold');
    const patientId = requireUuid(input.patientId, 'Patient');
    if (typeof input.token !== 'string' || input.token.length === 0) throw new DomainError('INVALID_TOKEN', 'Invalid confirmation token');
    // A patient actor can only book for themselves (RN-007).
    if (ctx.actor.type === 'patient' && ctx.actor.id !== patientId) throw new DomainError('FORBIDDEN', 'Not allowed');
    const requestHash = sha256(canonicalJson({ op: 'confirm', holdId, patientId, token: input.token }));
    const now = clock(ctx);

    try {
      return await withTx(this.pool, async (c) => {
        const replay = await beginIdempotent<ConfirmResult>(c, ctx.tenantId, input.idempotencyKey, requestHash);
        if (replay) return { ...replay, replayed: true };

        const pre = await one<{ professional_id: string }>(c, 'SELECT professional_id FROM booking_holds WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, holdId]);
        if (!pre) throw notFound('Hold');
        await lockProfessionalAgenda(c, ctx.tenantId, pre.professional_id);
        const hold = await one<{
          clinic_id: string; professional_id: string; service_id: string; start_at: Date; end_at: Date; occupied_until: Date;
          status: string; expires_at: Date; token_hash: string;
        }>(c, 'SELECT * FROM booking_holds WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [ctx.tenantId, holdId]);
        if (!hold) throw notFound('Hold');

        if (!safeEqualHex(sha256(input.token), hold.token_hash)) throw new DomainError('INVALID_TOKEN', 'Invalid confirmation token');
        if (hold.status === 'EXPIRED' || (hold.status === 'ACTIVE' && hold.expires_at.getTime() <= now.getTime())) {
          throw new DomainError('HOLD_EXPIRED', 'The hold has expired');
        }
        if (hold.status !== 'ACTIVE') throw new DomainError('HOLD_NOT_ACTIVE', `The hold is ${hold.status}`);

        const patient = await one(c, 'SELECT 1 FROM patients WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, patientId]);
        if (!patient) throw notFound('Patient');
        const clinic = await one<ClinicRow>(c, 'SELECT * FROM clinics WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, hold.clinic_id]);

        let appointmentId: string;
        try {
          const ins = await c.query<{ id: string }>(
            `INSERT INTO appointments
               (tenant_id, clinic_id, patient_id, professional_id, service_id, start_at, end_at, occupied_until, status, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CONFIRMED',$9,$9) RETURNING id`,
            [ctx.tenantId, hold.clinic_id, patientId, hold.professional_id, hold.service_id, hold.start_at, hold.end_at, hold.occupied_until, now],
          );
          appointmentId = ins.rows[0]!.id;
        } catch (e) {
          mapSlotConflict(e);
        }
        await c.query(`UPDATE booking_holds SET status = 'CONSUMED', appointment_id = $3 WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, holdId, appointmentId]);
        await audit(c, ctx, { action: 'appointment.confirmed', objectType: 'appointment', objectId: appointmentId, metadata: { holdId } });
        await outbox(c, ctx.tenantId, 'appointment', appointmentId, 'appointment.confirmed');

        const result: ConfirmResult = {
          appointmentId, status: 'CONFIRMED', startsAt: hold.start_at.toISOString(), endsAt: hold.end_at.toISOString(),
          timezone: clinic!.timezone, syncStatus: 'NOT_APPLICABLE',
        };
        await c.query('UPDATE idempotency_keys SET response = $3 WHERE tenant_id = $1 AND key = $2', [ctx.tenantId, input.idempotencyKey, JSON.stringify(result)]);
        return result;
      });
    } catch (e) {
      if (isDomainError(e, 'IDEMPOTENCY_MISMATCH')) {
        // Evidence of a reused key with a different payload (TC-022); written outside the rolled-back transaction.
        await audit(this.pool, ctx, { action: 'idempotency.mismatch', objectType: 'idempotency_key', objectId: sha256(input.idempotencyKey) }).catch(() => undefined);
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ cancel (RF-031, UC-05)

  async cancelAppointment(ctx: Ctx, input: { appointmentId: string; reason?: string }): Promise<CancelResult> {
    const appointmentId = requireUuid(input.appointmentId, 'Appointment');
    const now = clock(ctx);
    return withTx(this.pool, async (c) => {
      const pre = await one<{ professional_id: string }>(c, 'SELECT professional_id FROM appointments WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, appointmentId]);
      if (!pre) throw notFound('Appointment');
      await lockProfessionalAgenda(c, ctx.tenantId, pre.professional_id);
      const appt = await one<{ patient_id: string; status: string; start_at: Date; clinic_id: string; version: number }>(
        c, 'SELECT patient_id, status, start_at, clinic_id, version FROM appointments WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [ctx.tenantId, appointmentId]);
      if (!appt) throw notFound('Appointment');
      // Do not reveal other patients' appointments (RN-007).
      if (ctx.actor.type === 'patient' && ctx.actor.id !== appt.patient_id) throw notFound('Appointment');

      if (appt.status === 'CANCELLED') return { appointmentId, status: 'CANCELLED', alreadyCancelled: true }; // TC-040
      assertAppointmentTransition(appt.status as never, 'CANCELLED');

      if (ctx.actor.type === 'patient' || ctx.actor.type === 'agent') {
        const clinic = await one<ClinicRow>(c, 'SELECT * FROM clinics WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, appt.clinic_id]);
        const closesAt = appt.start_at.getTime() - clinic!.cancellation_notice_min * 60_000;
        if (now.getTime() >= appt.start_at.getTime() || now.getTime() > closesAt) {
          throw new DomainError('CANCELLATION_WINDOW_CLOSED', 'The cancellation window has closed; contact the clinic');
        }
      }
      await c.query(
        `UPDATE appointments SET status = 'CANCELLED', cancelled_at = $3, cancellation_reason = $4, cancelled_by = $5,
                version = version + 1, updated_at = $3
          WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, appointmentId, now, input.reason ?? null, actorRef(ctx)],
      );
      await audit(c, ctx, { action: 'appointment.cancelled', objectType: 'appointment', objectId: appointmentId, reason: input.reason });
      await outbox(c, ctx.tenantId, 'appointment', appointmentId, 'appointment.cancelled');
      return { appointmentId, status: 'CANCELLED', alreadyCancelled: false };
    });
  }

  // ------------------------------------------------------------------ availability changes (RF-032)

  /**
   * Adds a holiday/absence/block. Overlapping active holds are released; overlapping appointments are NOT
   * touched: they are returned so an operator decides (never reprogram without authorization).
   */
  async createScheduleException(
    ctx: Ctx,
    input: { clinicId: string; professionalId?: string; kind: 'HOLIDAY' | 'ABSENCE' | 'BLOCK'; startsAt: Date; endsAt: Date; reason?: string },
  ): Promise<{ exceptionId: string; affectedAppointments: { id: string; startsAt: Date; professionalId: string }[]; releasedHolds: number }> {
    const clinicId = requireUuid(input.clinicId, 'Clinic');
    const startsAt = requireDate(input.startsAt, 'startsAt');
    const endsAt = requireDate(input.endsAt, 'endsAt');
    if (!(startsAt < endsAt)) throw new DomainError('VALIDATION', 'startsAt must be before endsAt');
    const professionalId = input.professionalId ? requireUuid(input.professionalId, 'Professional') : null;

    return withTx(this.pool, async (c) => {
      const clinic = await one(c, 'SELECT 1 FROM clinics WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, clinicId]);
      if (!clinic) throw notFound('Clinic');
      const affectedProfs = await rows<{ id: string }>(
        c, `SELECT id FROM professionals WHERE tenant_id = $1 AND clinic_id = $2 AND ($3::uuid IS NULL OR id = $3) ORDER BY id`,
        [ctx.tenantId, clinicId, professionalId]);
      if (professionalId && affectedProfs.length === 0) throw notFound('Professional');
      for (const p of affectedProfs) await lockProfessionalAgenda(c, ctx.tenantId, p.id); // sorted: no deadlocks
      const ids = affectedProfs.map((p) => p.id);

      const ins = await c.query<{ id: string }>(
        `INSERT INTO schedule_exceptions (tenant_id, clinic_id, professional_id, kind, starts_at, ends_at, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ctx.tenantId, clinicId, professionalId, input.kind, startsAt, endsAt, input.reason ?? null, actorRef(ctx)]);
      const exceptionId = ins.rows[0]!.id;

      const released = await c.query(
        `UPDATE booking_holds SET status = 'RELEASED'
          WHERE tenant_id = $1 AND professional_id = ANY($2::uuid[]) AND status = 'ACTIVE'
            AND start_at < $4 AND occupied_until > $3`,
        [ctx.tenantId, ids, startsAt, endsAt]);
      const affected = await rows<{ id: string; start_at: Date; professional_id: string }>(
        c, `SELECT id, start_at, professional_id FROM appointments
             WHERE tenant_id = $1 AND professional_id = ANY($2::uuid[]) AND status = ANY($5::text[])
               AND start_at < $4 AND end_at > $3 ORDER BY start_at`,
        [ctx.tenantId, ids, startsAt, endsAt, BLOCKING_APPOINTMENT_STATUSES]);

      await audit(c, ctx, {
        action: 'schedule_exception.created', objectType: 'schedule_exception', objectId: exceptionId, reason: input.reason,
        metadata: { kind: input.kind, affectedAppointments: affected.length, releasedHolds: released.rowCount ?? 0 },
      });
      return {
        exceptionId, releasedHolds: released.rowCount ?? 0,
        affectedAppointments: affected.map((a) => ({ id: a.id, startsAt: a.start_at, professionalId: a.professional_id })),
      };
    });
  }

  // ------------------------------------------------------------------ internals

  private async loadAgenda(
    q: Queryable, tenantId: string, clinicId: string, professionalIds: string[], from: Date, to: Date, now: Date,
  ): Promise<Map<string, { rules: WeeklyRule[]; blocks: Interval[]; busy: Interval[] }>> {
    const lo = new Date(from.getTime() - 2 * DAY_MS);
    const hi = new Date(to.getTime() + 2 * DAY_MS);
    // Sequential on purpose: `q` may be a transaction client, which cannot run queries concurrently.
    const rules = await rows<{ professional_id: string; weekday: number; start_minute: number; end_minute: number }>(
        q, 'SELECT professional_id, weekday, start_minute, end_minute FROM schedules WHERE tenant_id = $1 AND professional_id = ANY($2::uuid[])', [tenantId, professionalIds]);
    const blocks = await rows<{ professional_id: string | null; starts_at: Date; ends_at: Date }>(
        q, `SELECT professional_id, starts_at, ends_at FROM schedule_exceptions
             WHERE tenant_id = $1 AND clinic_id = $2 AND (professional_id IS NULL OR professional_id = ANY($3::uuid[]))
               AND starts_at < $5 AND ends_at > $4`, [tenantId, clinicId, professionalIds, lo, hi]);
    const appts = await rows<{ professional_id: string; start_at: Date; occupied_until: Date }>(
        q, `SELECT professional_id, start_at, occupied_until FROM appointments
             WHERE tenant_id = $1 AND professional_id = ANY($2::uuid[]) AND status = ANY($3::text[])
               AND start_at < $5 AND occupied_until > $4`, [tenantId, professionalIds, BLOCKING_APPOINTMENT_STATUSES, lo, hi]);
    const holds = await rows<{ professional_id: string; start_at: Date; occupied_until: Date }>(
        q, `SELECT professional_id, start_at, occupied_until FROM booking_holds
             WHERE tenant_id = $1 AND professional_id = ANY($2::uuid[]) AND status = 'ACTIVE' AND expires_at > $5
               AND start_at < $4 AND occupied_until > $3`, [tenantId, professionalIds, lo, hi, now]);
    const map = new Map<string, { rules: WeeklyRule[]; blocks: Interval[]; busy: Interval[] }>();
    for (const id of professionalIds) map.set(id, { rules: [], blocks: [], busy: [] });
    for (const r of rules) map.get(r.professional_id)!.rules.push({ weekday: r.weekday, startMinute: r.start_minute, endMinute: r.end_minute });
    for (const b of blocks) {
      for (const [id, a] of map) if (b.professional_id === null || b.professional_id === id) a.blocks.push({ start: b.starts_at, end: b.ends_at });
    }
    for (const a of appts) map.get(a.professional_id)!.busy.push({ start: a.start_at, end: a.occupied_until });
    for (const h of holds) map.get(h.professional_id)!.busy.push({ start: h.start_at, end: h.occupied_until });
    return map;
  }

  private generate(
    clinic: ClinicRow, service: ServiceRow, a: { rules: WeeklyRule[]; blocks: Interval[]; busy: Interval[] },
    from: Date, to: Date, now: Date,
  ): Slot[] {
    return generateSlots({
      timezone: clinic.timezone, rules: a.rules, blocks: a.blocks, busy: a.busy,
      durationMin: service.duration_min, bufferMin: service.buffer_min, stepMin: clinic.slot_step_min,
      from, to, now, minNoticeMin: clinic.booking_min_notice_min,
    });
  }
}

// ---------------------------------------------------------------------- helpers

const actorRef = (ctx: Ctx): string => `${ctx.actor.type}:${ctx.actor.id ?? 'n/a'}`;

export async function audit(
  q: Queryable, ctx: Ctx,
  e: { action: string; objectType: string; objectId?: string; reason?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await q.query(
    `INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, object_type, object_id, reason, origin, correlation_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduling',$8,$9)`,
    [ctx.tenantId, ctx.actor.type, ctx.actor.id ?? null, e.action, e.objectType, e.objectId ?? null, e.reason ?? null,
      ctx.correlationId ?? null, JSON.stringify(e.metadata ?? {})],
  );
}

/** Same transaction as the business change (transactional outbox, spec 14.4). Identifiers only, no personal data. */
async function outbox(c: PoolClient, tenantId: string, aggregateType: string, aggregateId: string, type: string): Promise<void> {
  await c.query(
    'INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, type, payload_min) VALUES ($1,$2,$3,$4,$5)',
    [tenantId, aggregateType, aggregateId, type, JSON.stringify({ id: aggregateId })],
  );
}

/**
 * Claims an idempotency key inside the business transaction. A concurrent request with the same key blocks on the
 * unique index until the first one commits, then replays its stored response. Returns the stored response on replay.
 */
async function beginIdempotent<T>(c: PoolClient, tenantId: string, key: string, requestHash: string): Promise<T | null> {
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw new DomainError('VALIDATION', 'Idempotency-Key must be 8-200 characters');
  }
  const ins = await c.query(
    'INSERT INTO idempotency_keys (tenant_id, key, request_hash) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, key) DO NOTHING',
    [tenantId, key, requestHash]);
  if (ins.rowCount === 1) return null;
  const prev = await one<{ request_hash: string; response: T | null }>(c, 'SELECT request_hash, response FROM idempotency_keys WHERE tenant_id = $1 AND key = $2', [tenantId, key]);
  if (!prev || prev.request_hash !== requestHash) throw new DomainError('IDEMPOTENCY_MISMATCH', 'Idempotency-Key was already used with a different request');
  if (!prev.response) throw new DomainError('HOLD_NOT_ACTIVE', 'A previous attempt with this key did not complete');
  return prev.response;
}
