import { randomUUID } from 'node:crypto';
import { DomainError, isDomainError } from '@turnoflow/domain';
import { DirectoryService, InboxService, SchedulingService, type Ctx } from '@turnoflow/db';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z, ZodError } from 'zod';
import { registerWhatsAppWebhook, type WhatsAppConfig } from './whatsapp.ts';
import { can, verifySessionToken, type Permission, type Session } from './auth.ts';

export interface AppOptions {
  pool: Pool;
  /** HMAC secret for interim session tokens (min 32 chars). */
  authSecret: string;
  /** Enables the signed WhatsApp webhook. Omit to keep the route off. */
  whatsapp?: WhatsAppConfig;
  /** Test hook for a fixed clock. */
  now?: () => Date;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest { session?: Session; correlationId: string }
}

const uuid = z.string().uuid();
const isoDate = z.string().datetime({ offset: true }).transform((s) => new Date(s));

const availabilityQuery = z.object({ clinicId: uuid, serviceId: uuid, from: isoDate, to: isoDate, professionalId: uuid.optional() }).strict();
const holdBody = z.object({ professionalId: uuid, serviceId: uuid, startsAt: isoDate }).strict();
const confirmBody = z.object({ holdId: uuid, patientId: uuid, confirmationToken: z.string().min(16).max(128) }).strict();
const cancelBody = z.object({ reason: z.string().max(500).optional() }).strict().default({});
const idParams = z.object({ id: uuid });
const catalogQuery = z.object({ clinicId: uuid }).strict();
const agendaQuery = z.object({ clinicId: uuid, from: isoDate, to: isoDate, professionalId: uuid.optional() }).strict();
const modeEnum = z.enum(['BOT', 'HUMAN_PENDING', 'HUMAN_ACTIVE', 'CLOSED']);
const inboxQuery = z.object({ mode: modeEnum.optional(), before: isoDate.optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();
const messageBody = z.object({ body: z.string().min(1).max(4000) }).strict();
const patientSearch = z.object({ q: z.string().max(80) }).strict();
const patientBody = z.object({ fullName: z.string().min(2).max(120), phone: z.string().min(7).max(30) }).strict();

const TYPE_BASE = 'https://turnoflow.dev/problems/';

function problem(reply: FastifyReply, req: FastifyRequest, status: number, code: string, detail: string, extra: object = {}) {
  return reply.status(status).header('content-type', 'application/problem+json').send({
    type: `${TYPE_BASE}${code.toLowerCase().replace(/_/g, '-')}`, title: code, status, detail,
    instance: req.url.split('?')[0], correlationId: req.correlationId, ...extra,
  });
}

export function buildApp(opts: AppOptions): FastifyInstance {
  if (opts.authSecret.length < 32) throw new Error('authSecret must be at least 32 characters');
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 16 * 1024, genReqId: () => randomUUID() });
  const svc = new SchedulingService(opts.pool);
  const dir = new DirectoryService(opts.pool);
  const inbox = new InboxService(opts.pool);

  app.decorateRequest('correlationId', '');
  app.addHook('onRequest', async (req, reply) => {
    const supplied = req.headers['x-correlation-id'];
    req.correlationId = typeof supplied === 'string' && /^[\w-]{8,64}$/.test(supplied) ? supplied : randomUUID();
    reply.header('x-correlation-id', req.correlationId);
  });

  app.setErrorHandler((err, req, reply) => {
    if (isDomainError(err)) return problem(reply, req, err.status, err.code, err.message);
    if (err instanceof ZodError) {
      return problem(reply, req, 422, 'VALIDATION', 'Invalid request', {
        errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const fe = err as { statusCode?: number; code?: string };
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return problem(reply, req, fe.statusCode, fe.code ?? 'BAD_REQUEST', 'Bad request');
    }
    req.log.error({ err: { name: (err as Error).name, message: (err as Error).message }, correlationId: req.correlationId }, 'unhandled');
    return problem(reply, req, 500, 'INTERNAL', 'Unexpected error'); // never leak internals
  });
  app.setNotFoundHandler((req, reply) => problem(reply, req, 404, 'NOT_FOUND', 'Route not found'));

  const guard = (permission: Permission) => async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const session = token ? verifySessionToken(opts.authSecret, token) : null;
    if (!session) return problem(reply, req, 401, 'UNAUTHENTICATED', 'Missing or invalid credentials');
    if (!can(session.role, permission)) return problem(reply, req, 403, 'FORBIDDEN', 'Not allowed');
    req.session = session;
  };

  /** Tenant and actor come ONLY from the verified session (spec 12). */
  const ctxOf = (req: FastifyRequest): Ctx => ({
    tenantId: req.session!.tenantId,
    actor: { type: 'user', id: req.session!.userId },
    correlationId: req.correlationId,
    ...(opts.now ? { now: opts.now() } : {}),
  });

  const v1 = '/api/v1';

  if (opts.whatsapp) {
    if (opts.whatsapp.appSecret.length < 16 || opts.whatsapp.verifyToken.length < 16) throw new Error('WhatsApp secrets must be at least 16 characters');
    registerWhatsAppWebhook(app, opts.pool, opts.whatsapp);
  }

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get(`${v1}/availability`, { preHandler: guard('schedule.read') }, async (req) => {
    const q = availabilityQuery.parse(req.query);
    const r = await svc.searchAvailability(ctxOf(req), q);
    return {
      timezone: r.timezone,
      slots: r.slots.map((s) => ({ professionalId: s.professionalId, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })),
    };
  });

  app.post(`${v1}/booking-holds`, { preHandler: guard('appointment.create') }, async (req, reply) => {
    const b = holdBody.parse(req.body);
    const h = await svc.createHold(ctxOf(req), b);
    return reply.status(201).send({
      holdId: h.holdId, confirmationToken: h.token, expiresAt: h.expiresAt.toISOString(),
      startsAt: h.startsAt.toISOString(), endsAt: h.endsAt.toISOString(), timezone: h.timezone,
    });
  });

  app.post(`${v1}/appointments/confirm`, { preHandler: guard('appointment.create') }, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string') throw new DomainError('VALIDATION', 'Idempotency-Key header is required');
    const b = confirmBody.parse(req.body);
    const r = await svc.confirmAppointment(ctxOf(req), { holdId: b.holdId, patientId: b.patientId, token: b.confirmationToken, idempotencyKey: key });
    const { replayed, ...body } = r;
    if (replayed) reply.header('idempotent-replayed', 'true');
    return reply.status(201).send(body);
  });

  app.post(`${v1}/appointments/:id/cancel`, { preHandler: guard('appointment.cancel') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const b = cancelBody.parse(req.body ?? {});
    return svc.cancelAppointment(ctxOf(req), { appointmentId: id, reason: b.reason });
  });

  // ---- read models for the reception panel
  app.get(`${v1}/clinics`, { preHandler: guard('schedule.read') }, async (req) => ({ clinics: await dir.listClinics(ctxOf(req)) }));

  app.get(`${v1}/catalog`, { preHandler: guard('schedule.read') }, async (req) => dir.getCatalog(ctxOf(req), catalogQuery.parse(req.query).clinicId));

  app.get(`${v1}/agenda`, { preHandler: guard('appointment.read') }, async (req) => {
    const q = agendaQuery.parse(req.query);
    const items = await dir.listAgenda(ctxOf(req), q);
    return { items: items.map((i) => ({ ...i, startsAt: i.startsAt.toISOString(), endsAt: i.endsAt.toISOString() })) };
  });

  app.get(`${v1}/patients`, { preHandler: guard('patient.read') }, async (req) => ({
    patients: await dir.searchPatients(ctxOf(req), patientSearch.parse(req.query).q),
  }));

  app.post(`${v1}/patients`, { preHandler: guard('patient.write') }, async (req, reply) =>
    reply.status(201).send(await dir.createPatient(ctxOf(req), patientBody.parse(req.body))));

  // ---- inbox and human handoff (RF-020..022)
  /** Administrators may free a conversation held by someone else. */
  const isAdmin = (req: FastifyRequest) => req.session!.role === 'owner' || req.session!.role === 'admin_clinic';
  const wire = (c: Awaited<ReturnType<InboxService['get']>>) => ({ ...c, lastActivityAt: c.lastActivityAt.toISOString() });

  app.get(`${v1}/inbox/conversations`, { preHandler: guard('inbox.read') }, async (req) => {
    const q = inboxQuery.parse(req.query);
    const items = await inbox.list(ctxOf(req), q);
    return { me: `user:${req.session!.userId}`, items: items.map(wire) };
  });

  app.get(`${v1}/inbox/conversations/:id/messages`, { preHandler: guard('inbox.read') }, async (req) => {
    const { id } = idParams.parse(req.params);
    const ctx = ctxOf(req);
    const [conversation, messages] = [await inbox.get(ctx, id), await inbox.messages(ctx, id)];
    return {
      me: `user:${req.session!.userId}`, conversation: wire(conversation),
      messages: messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    };
  });

  app.post(`${v1}/inbox/conversations/:id/takeover`, { preHandler: guard('inbox.takeover') }, async (req) =>
    inbox.takeover(ctxOf(req), { conversationId: idParams.parse(req.params).id }));

  app.post(`${v1}/inbox/conversations/:id/release`, { preHandler: guard('inbox.takeover') }, async (req) =>
    inbox.release(ctxOf(req), { conversationId: idParams.parse(req.params).id, override: isAdmin(req) }));

  app.post(`${v1}/inbox/conversations/:id/close`, { preHandler: guard('inbox.takeover') }, async (req) =>
    inbox.close(ctxOf(req), { conversationId: idParams.parse(req.params).id, override: isAdmin(req) }));

  app.post(`${v1}/inbox/conversations/:id/messages`, { preHandler: guard('inbox.takeover') }, async (req, reply) =>
    reply.status(201).send(await inbox.sendHumanMessage(ctxOf(req), { conversationId: idParams.parse(req.params).id, body: messageBody.parse(req.body).body })));

  return app;
}
