import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { InboxService } from '@turnoflow/db';
import { NOW, createWorld, makePool, type World } from '../../../packages/db/test/fixtures.ts';
import { buildApp, signSessionToken, type Role } from '../src/index.ts';

const SECRET = 'test-secret-test-secret-test-secret-123';
let pool: Pool;
let app: FastifyInstance;
beforeAll(() => { pool = makePool(30); app = buildApp({ pool, authSecret: SECRET, now: () => NOW }); });
afterAll(async () => { await app.close(); await pool.end(); });

const token = (w: { tenantId: string }, role: Role = 'receptionist') => signSessionToken(SECRET, { userId: 'u-1', tenantId: w.tenantId, role });
const auth = (w: { tenantId: string }, role?: Role) => ({ authorization: `Bearer ${token(w, role)}` });
const SLOT = '2030-01-07T12:00:00.000Z';
const day = 'clinicId' as const;

async function hold(w: World, startsAt = SLOT, role?: Role) {
  return app.inject({ method: 'POST', url: '/api/v1/booking-holds', headers: auth(w, role), payload: { professionalId: w.professionalId, serviceId: w.serviceId, startsAt } });
}
async function confirm(w: World, h: { holdId: string; confirmationToken: string }, patientId: string, key = `key-${randomUUID()}`) {
  return app.inject({ method: 'POST', url: '/api/v1/appointments/confirm', headers: { ...auth(w), 'idempotency-key': key }, payload: { holdId: h.holdId, patientId, confirmationToken: h.confirmationToken } });
}

describe('authentication and RBAC (RF-004, RNF-003)', () => {
  it('rejects missing, forged, expired and cross-secret tokens with 401 problem+json', async () => {
    const w = await createWorld(pool);
    const url = `/api/v1/availability?clinicId=${w.clinicId}&serviceId=${w.serviceId}&from=2030-01-07T03:00:00Z&to=2030-01-08T03:00:00Z`;
    const expired = signSessionToken(SECRET, { userId: 'u', tenantId: w.tenantId, role: 'owner' }, 60, 1000);
    const forged = signSessionToken('another-secret-another-secret-12345', { userId: 'u', tenantId: w.tenantId, role: 'owner' });
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: `Bearer ${expired}` }, { authorization: `Bearer ${forged}` }]) {
      const r = await app.inject({ method: 'GET', url, headers });
      expect(r.statusCode).toBe(401);
      expect(r.headers['content-type']).toContain('application/problem+json');
    }
  });

  it('enforces permissions per role', async () => {
    const w = await createWorld(pool);
    const q = `/api/v1/availability?clinicId=${w.clinicId}&serviceId=${w.serviceId}&from=2030-01-07T03:00:00Z&to=2030-01-08T03:00:00Z`;
    expect((await app.inject({ method: 'GET', url: q, headers: auth(w, 'practitioner') })).statusCode).toBe(200);
    expect((await hold(w, SLOT, 'practitioner')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: q, headers: auth(w, 'support_limited') })).statusCode).toBe(403);
    expect((await hold(w, SLOT, 'receptionist')).statusCode).toBe(201);
  });
});

describe('availability -> hold -> confirm -> cancel over HTTP', () => {
  it('runs the whole booking flow and returns the spec shape (201 with appointmentId, status, startsAt...)', async () => {
    const w = await createWorld(pool);
    const av = await app.inject({ method: 'GET', url: `/api/v1/availability?clinicId=${w.clinicId}&serviceId=${w.serviceId}&from=2030-01-07T03:00:00Z&to=2030-01-08T03:00:00Z`, headers: auth(w) });
    expect(av.statusCode).toBe(200);
    expect(av.json().slots[0]).toMatchObject({ professionalId: w.professionalId, startsAt: SLOT });
    expect(av.json().slots).toHaveLength(8);

    const h = await hold(w, av.json().slots[0].startsAt);
    expect(h.statusCode).toBe(201);
    const c = await confirm(w, h.json(), w.patientIds[0]!);
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ status: 'CONFIRMED', startsAt: SLOT, timezone: 'America/Argentina/Buenos_Aires', syncStatus: 'NOT_APPLICABLE' });

    const after = await app.inject({ method: 'GET', url: `/api/v1/availability?clinicId=${w.clinicId}&serviceId=${w.serviceId}&from=2030-01-07T03:00:00Z&to=2030-01-08T03:00:00Z`, headers: auth(w) });
    expect(after.json().slots).toHaveLength(7);

    const cancel = () => app.inject({ method: 'POST', url: `/api/v1/appointments/${c.json().appointmentId}/cancel`, headers: auth(w), payload: { reason: 'prueba' } });
    expect((await cancel()).json()).toMatchObject({ status: 'CANCELLED', alreadyCancelled: false });
    expect((await cancel()).json()).toMatchObject({ status: 'CANCELLED', alreadyCancelled: true });
  });

  it('maps domain errors to HTTP statuses: 409 taken, 422 not offered, 410 expired', async () => {
    const w = await createWorld(pool);
    const h1 = await hold(w);
    expect(h1.statusCode).toBe(201);
    const taken = await hold(w);
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ title: 'SLOT_TAKEN', status: 409 });
    expect(taken.json().correlationId).toBeTruthy();
    expect((await hold(w, '2030-01-07T20:00:00.000Z')).statusCode).toBe(422);

    const lateApp = buildApp({ pool, authSecret: SECRET, now: () => new Date(NOW.getTime() + 11 * 60_000) });
    const late = await lateApp.inject({
      method: 'POST', url: '/api/v1/appointments/confirm', headers: { ...auth(w), 'idempotency-key': 'key-late-1234' },
      payload: { holdId: h1.json().holdId, patientId: w.patientIds[0], confirmationToken: h1.json().confirmationToken },
    });
    expect(late.statusCode).toBe(410);
    await lateApp.close();
  });

  it('TC-021/022 over HTTP: same key replays, different payload is 409', async () => {
    const w = await createWorld(pool);
    const h = (await hold(w)).json();
    const key = `idem-${randomUUID()}`;
    const a = await confirm(w, h, w.patientIds[0]!, key);
    const b = await confirm(w, h, w.patientIds[0]!, key);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect((await confirm(w, h, w.patientIds[1]!, key)).statusCode).toBe(409);
  });

  it('requires Idempotency-Key and validates input strictly (422), including unknown fields', async () => {
    const w = await createWorld(pool);
    const h = (await hold(w)).json();
    const noKey = await app.inject({ method: 'POST', url: '/api/v1/appointments/confirm', headers: auth(w), payload: { holdId: h.holdId, patientId: w.patientIds[0], confirmationToken: h.confirmationToken } });
    expect(noKey.statusCode).toBe(422);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/booking-holds', headers: auth(w), payload: { professionalId: 'x', serviceId: w.serviceId, startsAt: 'tomorrow' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors.length).toBeGreaterThan(0);
    const extra = await app.inject({ method: 'POST', url: '/api/v1/booking-holds', headers: auth(w), payload: { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: SLOT, tenantId: randomUUID() } });
    expect(extra.statusCode).toBe(422); // a tenantId in the body is never accepted
  });
});

describe('TC-100 over HTTP: tenant isolation', () => {
  it('tenant B using its own valid token cannot touch tenant A resources, and learns nothing', async () => {
    const a = await createWorld(pool);
    const b = await createWorld(pool);
    const h = (await hold(a)).json();
    const c = (await confirm(a, h, a.patientIds[0]!)).json();

    const cancel = await app.inject({ method: 'POST', url: `/api/v1/appointments/${c.appointmentId}/cancel`, headers: auth(b), payload: {} });
    expect(cancel.statusCode).toBe(404);
    const holdOfA = await app.inject({ method: 'POST', url: '/api/v1/booking-holds', headers: auth(b), payload: { professionalId: a.professionalId, serviceId: b.serviceId, startsAt: SLOT } });
    expect(holdOfA.statusCode).toBe(404);
    const av = await app.inject({ method: 'GET', url: `/api/v1/availability?clinicId=${a.clinicId}&serviceId=${a.serviceId}&from=2030-01-07T03:00:00Z&to=2030-01-08T03:00:00Z`, headers: auth(b) });
    expect(av.statusCode).toBe(404);
    const st = await pool.query('SELECT status FROM appointments WHERE id = $1', [c.appointmentId]);
    expect(st.rows[0].status).toBe('CONFIRMED');
  });
});

describe('TC-020 over HTTP: 100 concurrent requests for one slot', () => {
  it('exactly one hold+confirm succeeds, the rest get 409', async () => {
    const w = await createWorld(pool, { patients: 100 });
    const results = await Promise.all(w.patientIds.map(async (pid) => {
      const h = await hold(w);
      if (h.statusCode !== 201) return h.statusCode;
      return (await confirm(w, h.json(), pid)).statusCode;
    }));
    expect(results.filter((s) => s === 201)).toHaveLength(1);
    expect(results.filter((s) => s === 409)).toHaveLength(99);
    const n = await pool.query(`SELECT count(*) FROM appointments WHERE tenant_id = $1 AND status = 'CONFIRMED'`, [w.tenantId]);
    expect(Number(n.rows[0].count)).toBe(1);
  });
});

describe('platform behaviour', () => {
  it('propagates correlation ids, hides internals and answers unknown routes with problem+json', async () => {
    const r = await app.inject({ method: 'GET', url: '/nope', headers: { 'x-correlation-id': 'corr-12345678' } });
    expect(r.statusCode).toBe(404);
    expect(r.headers['x-correlation-id']).toBe('corr-12345678');
    expect(r.json().correlationId).toBe('corr-12345678');
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
  });

  it('records the correlation id and actor in the audit trail', async () => {
    const w = await createWorld(pool);
    const r = await app.inject({ method: 'POST', url: '/api/v1/booking-holds', headers: { ...auth(w), 'x-correlation-id': 'audit-corr-0001' }, payload: { professionalId: w.professionalId, serviceId: w.serviceId, startsAt: SLOT } });
    expect(r.statusCode).toBe(201);
    const a = await pool.query(`SELECT actor_id, correlation_id FROM audit_events WHERE tenant_id = $1 AND action = 'booking_hold.created'`, [w.tenantId]);
    expect(a.rows[0]).toEqual({ actor_id: 'u-1', correlation_id: 'audit-corr-0001' });
  });
});

void day;

describe('panel read models and patients', () => {
  it('lists clinics, catalog and agenda; agenda needs appointment.read', async () => {
    const w = await createWorld(pool);
    const h = (await hold(w)).json();
    await confirm(w, h, w.patientIds[0]!);
    const clinics = await app.inject({ method: 'GET', url: '/api/v1/clinics', headers: auth(w) });
    expect(clinics.json().clinics).toHaveLength(1);
    const cat = await app.inject({ method: 'GET', url: `/api/v1/catalog?clinicId=${w.clinicId}`, headers: auth(w) });
    expect(cat.json().professionals[0]).toMatchObject({ id: w.professionalId, serviceIds: [w.serviceId] });
    expect(cat.json().services[0]).toMatchObject({ id: w.serviceId, durationMin: 30 });
    const url = `/api/v1/agenda?clinicId=${w.clinicId}&from=2030-01-07T03:00:00Z&to=2030-01-08T03:00:00Z`;
    const ag = await app.inject({ method: 'GET', url, headers: auth(w) });
    expect(ag.json().items).toHaveLength(1);
    expect(ag.json().items[0]).toMatchObject({ status: 'CONFIRMED', startsAt: SLOT, serviceName: 'Consulta' });
    expect((await app.inject({ method: 'GET', url, headers: auth(w, 'practitioner') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/agenda?clinicId=${w.clinicId}&from=2030-01-01T00:00:00Z&to=2030-02-01T00:00:00Z`, headers: auth(w) })).statusCode).toBe(422);
  });

  it('is tenant scoped: other tenants see neither clinic, agenda nor patients', async () => {
    const a = await createWorld(pool);
    const b = await createWorld(pool, { patients: 0 }); // B owns no patients: anything returned would be A's
    const h = (await hold(a)).json();
    await confirm(a, h, a.patientIds[0]!);
    const url = `/api/v1/agenda?clinicId=${a.clinicId}&from=2030-01-07T03:00:00Z&to=2030-01-08T03:00:00Z`;
    expect((await app.inject({ method: 'GET', url, headers: auth(b) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v1/catalog?clinicId=${a.clinicId}`, headers: auth(b) })).statusCode).toBe(404);
    const found = await app.inject({ method: 'GET', url: '/api/v1/patients?q=Paciente', headers: auth(b) });
    expect(found.json().patients).toEqual([]);
  });

  it('creates patients with normalized phones, rejects bad phones and duplicates, and searches by name or phone', async () => {
    const w = await createWorld(pool, { patients: 0 });
    const create = (payload: object) => app.inject({ method: 'POST', url: '/api/v1/patients', headers: auth(w), payload });
    const ok = await create({ fullName: '  Ana   Pérez ', phone: '+54 9 11 2233-4455' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ fullName: 'Ana Pérez', phone: '+5491122334455' });
    expect((await create({ fullName: 'Ana', phone: '11 2233 4455' })).statusCode).toBe(422); // no guessed country code
    expect((await create({ fullName: 'Otra Ana', phone: '+5491122334455' })).statusCode).toBe(409);
    for (const q of ['pérez', '2233', '+54911']) {
      const r = await app.inject({ method: 'GET', url: `/api/v1/patients?q=${encodeURIComponent(q)}`, headers: auth(w) });
      expect(r.json().patients.map((p: { fullName: string }) => p.fullName)).toEqual(['Ana Pérez']);
    }
    const wild = await app.inject({ method: 'GET', url: `/api/v1/patients?q=${encodeURIComponent('%%')}`, headers: auth(w) });
    expect(wild.json().patients).toEqual([]); // LIKE wildcards are escaped
    expect((await app.inject({ method: 'POST', url: '/api/v1/patients', headers: auth(w, 'practitioner'), payload: { fullName: 'X Y', phone: '+5491100000000' } })).statusCode).toBe(403);
    const audit = await pool.query(`SELECT metadata FROM audit_events WHERE tenant_id = $1 AND action = 'patient.created'`, [w.tenantId]);
    expect(JSON.stringify(audit.rows)).not.toContain('Pérez');
  });
});

describe('inbox over HTTP (RF-020..022, TC-030)', () => {
  const mk = async (w: World) => {
    const box = new InboxService(pool);
    const { id } = await box.openConversation({ tenantId: w.tenantId, actor: { type: 'system' } }, { clinicId: w.clinicId, channel: 'WHATSAPP', externalRef: `wa-${randomUUID()}`, patientId: w.patientIds[0] });
    await box.recordInbound({ tenantId: w.tenantId, actor: { type: 'system' } }, { conversationId: id, body: 'Hola, necesito un turno' });
    return id;
  };
  const post = (w: World, url: string, role?: Role, payload: object = {}, user = 'u-1') =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${signSessionToken(SECRET, { userId: user, tenantId: w.tenantId, role: role ?? 'receptionist' })}` }, payload });

  it('lists, takes over, replies, releases; only the assignee can reply; roles are enforced', async () => {
    const w = await createWorld(pool);
    const id = await mk(w);
    const list = await app.inject({ method: 'GET', url: '/api/v1/inbox/conversations', headers: auth(w) });
    expect(list.json().items[0]).toMatchObject({ id, mode: 'BOT', patientName: expect.any(String), lastMessage: { body: 'Hola, necesito un turno' } });

    expect((await app.inject({ method: 'GET', url: '/api/v1/inbox/conversations', headers: auth(w, 'practitioner') })).statusCode).toBe(403);
    expect((await post(w, `/api/v1/inbox/conversations/${id}/takeover`, 'practitioner')).statusCode).toBe(403);

    const take = await post(w, `/api/v1/inbox/conversations/${id}/takeover`);
    expect(take.json()).toMatchObject({ mode: 'HUMAN_ACTIVE', assignedTo: 'user:u-1' });
    expect((await post(w, `/api/v1/inbox/conversations/${id}/takeover`, 'receptionist', {}, 'u-2')).statusCode).toBe(409);
    expect((await post(w, `/api/v1/inbox/conversations/${id}/messages`, 'receptionist', { body: 'hola' }, 'u-2')).statusCode).toBe(409);
    const reply = await post(w, `/api/v1/inbox/conversations/${id}/messages`, 'receptionist', { body: 'Hola, te ayudo con el turno' });
    expect(reply.statusCode).toBe(201);
    expect((await post(w, `/api/v1/inbox/conversations/${id}/messages`, 'receptionist', { body: '' })).statusCode).toBe(422);

    const thread = await app.inject({ method: 'GET', url: `/api/v1/inbox/conversations/${id}/messages`, headers: auth(w) });
    expect(thread.json().messages.map((m: { senderKind: string }) => m.senderKind)).toEqual(['PATIENT', 'HUMAN']);
    expect(thread.json().me).toBe('user:u-1');

    expect((await post(w, `/api/v1/inbox/conversations/${id}/release`, 'receptionist', {}, 'u-2')).statusCode).toBe(403);
    expect((await post(w, `/api/v1/inbox/conversations/${id}/release`, 'admin_clinic', {}, 'boss')).json()).toMatchObject({ mode: 'BOT' }); // admin override
    expect((await post(w, `/api/v1/inbox/conversations/${id}/close`)).json()).toMatchObject({ mode: 'CLOSED' });
  });

  it('is tenant scoped', async () => {
    const a = await createWorld(pool);
    const b = await createWorld(pool);
    const id = await mk(a);
    expect((await app.inject({ method: 'GET', url: '/api/v1/inbox/conversations', headers: auth(b) })).json().items).toEqual([]);
    expect((await post(b, `/api/v1/inbox/conversations/${id}/takeover`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v1/inbox/conversations/${id}/messages`, headers: auth(b) })).statusCode).toBe(404);
  });
});
