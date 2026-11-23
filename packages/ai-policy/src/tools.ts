import { DomainError, isDomainError } from '@turnoflow/domain';
import { DirectoryService, InboxService, SchedulingService, weeklyHours, type AgentConversation, type Catalog, type Ctx } from '@turnoflow/db';
import { DateTime } from 'luxon';
import type { Pool } from 'pg';
import { z } from 'zod';
import { isAffirmative, normalize } from './guards.ts';
import { TOOL_NAMES, type AgentPolicy, type AgentState, type Offer, type ToolName, type ToolSpec } from './types.ts';

export const TOOL_SPECS: ToolSpec[] = [
  { name: 'getApprovedPolicy', description: 'Approved clinic facts. Topics: horarios, practicas. Anything else is not available: hand off instead of guessing.' },
  { name: 'searchAvailability', description: 'Looks up REAL free slots for a practice between two dates (YYYY-MM-DD, max 14 days). Returns opaque slot references.' },
  { name: 'createHold', description: 'Temporarily holds one slot the patient chose, by the reference returned from searchAvailability. Never invent references.' },
  { name: 'confirmAppointment', description: 'Confirms the held slot. Only succeeds after the patient explicitly answered yes to the question asked for that slot.' },
  { name: 'cancelAppointment', description: 'Not available to the assistant: always routes to a person.' },
  { name: 'handoffToHuman', description: 'Passes the conversation to reception, with a short reason. Use whenever unsure, for coverage, prices, complaints or anything outside scheduling.' },
];

// Strict schemas: unknown fields are rejected, so a model (or an injected instruction) cannot smuggle extra parameters.
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SCHEMAS = {
  searchAvailability: z.object({ service: z.string().min(2).max(80), dateFrom: ymd, dateTo: ymd, professional: z.string().max(80).optional() }).strict(),
  createHold: z.object({ slotRef: z.string().regex(/^s[1-9]$/) }).strict(),
  confirmAppointment: z.object({}).strict(),
  cancelAppointment: z.object({}).strict(),
  handoffToHuman: z.object({ reason: z.string().min(3).max(200) }).strict(),
  getApprovedPolicy: z.object({ topic: z.enum(['horarios', 'practicas', 'cancelacion', 'cobertura', 'precios', 'direccion']) }).strict(),
} satisfies Record<ToolName, z.ZodTypeAny>;

export type ToolResult =
  | { ok: true; data?: Record<string, unknown>; /** Facts the orchestrator writes itself, so the model cannot alter them. */ reply?: string; handoff?: string; confirmed?: boolean }
  | { ok: false; error: string; message: string; handoff?: string };

export interface ToolEnv {
  pool: Pool;
  ctx: Ctx;
  conv: AgentConversation;
  state: AgentState;
  inboundMessageId: string;
  inboundText: string;
  policy: AgentPolicy;
  now: Date;
  scheduling: SchedulingService;
  inbox: InboxService;
  directory: DirectoryService;
  catalog?: Catalog;
}

const fail = (error: string, message: string, handoff?: string): ToolResult => ({ ok: false, error, message, handoff });
const clean = (s: string) => normalize(s);

export function isToolName(name: string): name is ToolName { return (TOOL_NAMES as readonly string[]).includes(name); }

/** Validates name and arguments, then runs the tool. A model can only ever reach this function: never SQL, never services directly. */
export async function runTool(env: ToolEnv, name: string, args: unknown): Promise<ToolResult> {
  if (!isToolName(name)) return fail('UNKNOWN_TOOL', 'That tool does not exist.');
  const parsed = SCHEMAS[name].safeParse(args ?? {});
  if (!parsed.success) return fail('INVALID_ARGS', `Invalid arguments: ${parsed.error.issues.map((i) => i.path.join('.') || 'args').join(', ')}`);
  try {
    switch (name) {
      case 'getApprovedPolicy': return await getApprovedPolicy(env, parsed.data as z.infer<typeof SCHEMAS.getApprovedPolicy>);
      case 'searchAvailability': return await searchAvailability(env, parsed.data as z.infer<typeof SCHEMAS.searchAvailability>);
      case 'createHold': return await createHold(env, parsed.data as z.infer<typeof SCHEMAS.createHold>);
      case 'confirmAppointment': return await confirmAppointment(env);
      case 'cancelAppointment':
        // D-06 is open: who may cancel through a chat is undefined, so the assistant never cancels (UC-05 needs a verified patient).
        return fail('REQUIRES_HUMAN', 'Cancellations are handled by reception.', 'Cancelación solicitada: requiere verificación de identidad (D-06)');
      case 'handoffToHuman': return { ok: true, handoff: (parsed.data as z.infer<typeof SCHEMAS.handoffToHuman>).reason };
    }
  } catch (e) {
    if (isDomainError(e)) return fail(e.code, e.message);
    throw e; // infrastructure problems are the orchestrator's fallback path
  }
}

async function catalogOf(env: ToolEnv): Promise<Catalog> {
  env.catalog ??= await env.directory.getCatalog(env.ctx, env.conv.clinicId);
  return env.catalog;
}

const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const DAYS = ['', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

async function getApprovedPolicy(env: ToolEnv, a: z.infer<typeof SCHEMAS.getApprovedPolicy>): Promise<ToolResult> {
  if (a.topic === 'practicas') {
    const cat = await catalogOf(env);
    return { ok: true, data: { available: true, text: cat.services.map((s) => `${s.name} (${s.durationMin} min)`).join(', ') } };
  }
  if (a.topic === 'horarios') {
    const rows = await weeklyHours(env.pool, env.ctx.tenantId, env.conv.clinicId);
    const byProf = new Map<string, string[]>();
    for (const r of rows) {
      const list = byProf.get(r.professional) ?? [];
      list.push(`${DAYS[r.weekday]} ${fmtMin(r.start_minute)}–${fmtMin(r.end_minute)}`);
      byProf.set(r.professional, list);
    }
    if (byProf.size === 0) return { ok: true, data: { available: false, text: 'No hay horarios cargados.' } };
    const text = [...byProf].map(([p, l]) => `${p}: ${l.join(', ')}`).join('. ').slice(0, 700);
    return { ok: true, data: { available: true, text } };
  }
  // Coverage, prices, address and cancellation policy have no approved, versioned source yet (RN-006, RF-025): never improvise.
  return { ok: true, data: { available: false, text: 'No tengo información aprobada sobre ese tema.' } };
}

async function searchAvailability(env: ToolEnv, a: z.infer<typeof SCHEMAS.searchAvailability>): Promise<ToolResult> {
  const cat = await catalogOf(env);
  const wanted = clean(a.service);
  const matches = cat.services.filter((s) => clean(s.name).includes(wanted) || wanted.includes(clean(s.name)));
  if (matches.length === 0) return fail('UNKNOWN_SERVICE', `Unknown practice. Available: ${cat.services.map((s) => s.name).join(', ')}`);
  if (matches.length > 1) return fail('AMBIGUOUS_SERVICE', `Ambiguous practice. Options: ${matches.map((s) => s.name).join(', ')}`);
  const service = matches[0]!;
  let professionalId: string | undefined;
  if (a.professional) {
    const p = cat.professionals.filter((x) => clean(x.name).includes(clean(a.professional!)));
    if (p.length !== 1) return fail('UNKNOWN_PROFESSIONAL', 'Professional not found or ambiguous.');
    professionalId = p[0]!.id;
  }
  const tz = env.conv.clinic.timezone;
  const today = DateTime.fromJSDate(env.now, { zone: tz }).startOf('day');
  let from = DateTime.fromISO(a.dateFrom, { zone: tz }).startOf('day');
  let to = DateTime.fromISO(a.dateTo, { zone: tz }).startOf('day');
  if (!from.isValid || !to.isValid || to < from) return fail('INVALID_DATES', 'Invalid date range.');
  if (from < today) from = today;
  if (to > from.plus({ days: env.policy.maxSearchDays - 1 })) to = from.plus({ days: env.policy.maxSearchDays - 1 });
  const res = await env.scheduling.searchAvailability(env.ctx, {
    clinicId: env.conv.clinicId, serviceId: service.id, from: from.toJSDate(), to: to.plus({ days: 1 }).toJSDate(), professionalId,
  });
  const names = new Map(cat.professionals.map((p) => [p.id, p.name]));
  const fmt = new Intl.DateTimeFormat('es-AR', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const offers: Offer[] = res.slots.slice(0, env.policy.maxOffers).map((s, i) => ({
    ref: `s${i + 1}`, professionalId: s.professionalId, serviceId: service.id, serviceName: service.name, professionalName: names.get(s.professionalId) ?? '',
    startsAt: s.startsAt.toISOString(), offeredAt: env.now.toISOString(),
    label: `${fmt.format(s.startsAt)} con ${names.get(s.professionalId) ?? 'el profesional'}`,
  }));
  env.state.offers = offers; // the only slots the patient may pick from; refs are meaningless outside this list
  if (offers.length === 0) return { ok: true, data: { offers: [], note: 'No free slots in that range.' } };
  const list = offers.map((o) => `${o.ref.slice(1)}) ${o.label}`).join('\n');
  return {
    ok: true, data: { offers: offers.map((o) => ({ ref: o.ref, label: o.label })) },
    reply: `Tengo estos horarios para ${service.name}:\n${list}\nRespondé con el número del que prefieras.`,
  };
}

async function createHold(env: ToolEnv, a: z.infer<typeof SCHEMAS.createHold>): Promise<ToolResult> {
  if (!env.conv.patientId) return fail('PATIENT_NOT_REGISTERED', 'The patient is not registered.', 'Paciente no registrado: requiere alta en recepción');
  const offer = env.state.offers.find((o) => o.ref === a.slotRef);
  const fresh = offer && env.now.getTime() - new Date(offer.offeredAt).getTime() <= env.policy.offerTtlMin * 60_000;
  if (!offer || !fresh) return fail('UNKNOWN_SLOT_REF', 'That slot was not offered to the patient (or the offer expired). Search again.');
  if (env.state.pending) { // only one temporary hold per conversation
    await env.scheduling.releaseHold(env.ctx, { holdId: env.state.pending.holdId, token: env.state.pending.token }).catch(() => undefined);
    env.state.pending = undefined;
  }
  try {
    const h = await env.scheduling.createHold(env.ctx, { professionalId: offer.professionalId, serviceId: offer.serviceId, startsAt: new Date(offer.startsAt) });
    env.state.pending = {
      holdId: h.holdId, token: h.token, label: offer.label, serviceName: offer.serviceName, expiresAt: h.expiresAt.toISOString(),
      heldDuringMessageId: env.inboundMessageId,
    };
    env.state.offers = [];
    return { ok: true, data: { held: true }, reply: `Reservé provisoriamente ${offer.label} (${offer.serviceName}). ¿Confirmo el turno? Respondé SÍ para confirmar o NO para dejarlo.` };
  } catch (e) {
    if (e instanceof DomainError && (e.code === 'SLOT_TAKEN' || e.code === 'SLOT_NOT_OFFERED')) {
      env.state.offers = env.state.offers.filter((o) => o.ref !== a.slotRef);
      return fail(e.code, 'That slot is no longer available.');
    }
    throw e;
  }
}

async function confirmAppointment(env: ToolEnv): Promise<ToolResult> {
  const p = env.state.pending;
  if (!p || new Date(p.expiresAt).getTime() <= env.now.getTime()) {
    env.state.pending = undefined;
    return fail('NO_PENDING_HOLD', 'There is no active temporary hold. Search and hold a slot first.');
  }
  if (!env.conv.patientId) return fail('PATIENT_NOT_REGISTERED', 'The patient is not registered.', 'Paciente no registrado: requiere alta en recepción');
  // Explicit consent: a yes written in a LATER message than the one that created the hold. The model cannot supply it.
  if (p.heldDuringMessageId === env.inboundMessageId || !isAffirmative(env.inboundText)) {
    return fail('PATIENT_CONFIRMATION_REQUIRED', 'The patient has not explicitly confirmed. Ask them to reply SÍ.');
  }
  await env.scheduling.confirmAppointment(env.ctx, {
    holdId: p.holdId, patientId: env.conv.patientId, token: p.token, idempotencyKey: `agent-${env.inboundMessageId}`,
  });
  env.state.pending = undefined;
  return {
    ok: true, confirmed: true, data: { confirmed: true },
    reply: `Listo, tu turno quedó confirmado: ${p.label} (${p.serviceName}). Si necesitás cambiarlo o cancelarlo, escribinos por acá y te ayuda recepción.`,
  };
}
