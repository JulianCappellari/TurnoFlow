import { DomainError, assertConversationTransition, botMayReply, type ConversationMode } from '@turnoflow/domain';
import type { Pool, PoolClient } from 'pg';
import { audit, type Ctx } from '../scheduling/service.ts';
import { isUuid, one, pgCode, rows, withTx } from '../tx.ts';

const MAX_BODY = 4000;

interface ConvRow {
  id: string; clinic_id: string; patient_id: string | null; channel: string; external_ref: string | null;
  mode: ConversationMode; version: number; assigned_to: string | null; escalation_reason: string | null; last_activity_at: Date;
}

export interface ConversationSummary {
  id: string; channel: string; mode: ConversationMode; version: number; assignedTo: string | null; escalationReason: string | null;
  lastActivityAt: Date; patientName: string | null; patientPhone: string | null; externalRef: string | null;
  lastMessage: { body: string; direction: string; senderKind: string } | null;
}
export interface MessageRow {
  id: string; direction: 'IN' | 'OUT'; senderKind: string; body: string; deliveryStatus: string; createdAt: Date; conversationVersion: number;
}
export interface ConversationState { id: string; mode: ConversationMode; version: number; assignedTo: string | null }

const notFound = () => new DomainError('NOT_FOUND', 'Conversation not found');
const need = (id: unknown): string => { if (!isUuid(id)) throw notFound(); return id; };
export const userRef = (ctx: Ctx): string => `user:${ctx.actor.id ?? 'unknown'}`;
const cleanBody = (body: unknown): string => {
  if (typeof body !== 'string' || body.trim().length === 0) throw new DomainError('VALIDATION', 'Message body is required');
  if (body.length > MAX_BODY) throw new DomainError('VALIDATION', `Message exceeds ${MAX_BODY} characters`);
  return body;
};

/**
 * Conversation storage and human handoff. The conversation row is the single point of serialization: every state
 * change and every bot message takes `SELECT ... FOR UPDATE` on it, so a takeover and a bot reply can never interleave.
 */
export class InboxService {
  constructor(private readonly pool: Pool) {}

  private async lock(c: PoolClient, ctx: Ctx, id: string): Promise<ConvRow> {
    const r = await one<ConvRow>(c, 'SELECT * FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [ctx.tenantId, need(id)]);
    if (!r) throw notFound();
    return r;
  }

  private async setMode(c: PoolClient, ctx: Ctx, conv: ConvRow, mode: ConversationMode, assignedTo: string | null, reason: string | null) {
    assertConversationTransition(conv.mode, mode);
    const r = await c.query<{ version: number }>(
      `UPDATE conversations SET mode = $3, assigned_to = $4, escalation_reason = $5, version = version + 1, updated_at = now(), last_activity_at = now()
        WHERE tenant_id = $1 AND id = $2 RETURNING version`, [ctx.tenantId, conv.id, mode, assignedTo, reason]);
    return r.rows[0]!.version;
  }

  // ---------------------------------------------------------------- creation / inbound (used by the webhook later)

  /** Find-or-create by (channel, externalRef): a repeated webhook never creates a second conversation. */
  async openConversation(ctx: Ctx, input: { clinicId: string; channel: 'WHATSAPP' | 'WEB'; externalRef: string; patientId?: string }): Promise<{ id: string; created: boolean }> {
    const clinicId = need(input.clinicId);
    const clinic = await one(this.pool, 'SELECT 1 FROM clinics WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, clinicId]);
    if (!clinic) throw new DomainError('NOT_FOUND', 'Clinic not found');
    const ins = await this.pool.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, clinic_id, patient_id, channel, external_ref) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, channel, external_ref) WHERE external_ref IS NOT NULL DO NOTHING RETURNING id`,
      [ctx.tenantId, clinicId, input.patientId ?? null, input.channel, input.externalRef]);
    if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
    const existing = await one<{ id: string }>(this.pool, 'SELECT id FROM conversations WHERE tenant_id = $1 AND channel = $2 AND external_ref = $3', [ctx.tenantId, input.channel, input.externalRef]);
    return { id: existing!.id, created: false };
  }

  /** Stores a patient message. Duplicate provider ids are ignored (RF-017). A closed conversation is reopened for the bot. */
  async recordInbound(ctx: Ctx, input: { conversationId: string; providerMessageId?: string; body: string }): Promise<{ messageId: string | null; duplicate: boolean; version: number }> {
    const body = cleanBody(input.body);
    return withTx(this.pool, async (c) => {
      let conv = await this.lock(c, ctx, input.conversationId);
      if (conv.mode === 'CLOSED') {
        const version = await this.setMode(c, ctx, conv, 'BOT', null, null);
        conv = { ...conv, mode: 'BOT', version };
      }
      const ins = await c.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, provider_message_id, direction, sender_kind, body, delivery_status, conversation_version)
         VALUES ($1,$2,$3,'IN','PATIENT',$4,'DELIVERED',$5) ON CONFLICT (tenant_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING RETURNING id`,
        [ctx.tenantId, conv.id, input.providerMessageId ?? null, body, conv.version]);
      if (!ins.rows[0]) return { messageId: null, duplicate: true, version: conv.version };
      await c.query('UPDATE conversations SET last_activity_at = now() WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, conv.id]);
      // Hand the message to the AI agent through the outbox, in the same transaction, only when the clinic enabled it
      // and a person is not already handling the conversation (RN-022).
      if (conv.mode === 'BOT') {
        const flag = await one<{ agent_enabled: boolean }>(c, 'SELECT agent_enabled FROM clinics WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, conv.clinic_id]);
        if (flag?.agent_enabled) {
          await c.query(
            `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, type, payload_min) VALUES ($1,'message',$2,'agent.inbound',$3)`,
            [ctx.tenantId, ins.rows[0].id, JSON.stringify({ conversationId: conv.id })]);
        }
      }
      return { messageId: ins.rows[0].id, duplicate: false, version: conv.version };
    });
  }

  /**
   * The only way the bot may write to a conversation (RF-022, TC-030). It must present the version it read; if a human has
   * taken, released or closed the conversation since, the write is refused and the caller must discard its draft.
   */
  async recordBotMessage(ctx: Ctx, input: { conversationId: string; expectedVersion: number; body: string }): Promise<{ messageId: string }> {
    const body = cleanBody(input.body);
    return withTx(this.pool, async (c) => {
      const conv = await this.lock(c, ctx, input.conversationId);
      if (!botMayReply(conv.mode) || conv.version !== input.expectedVersion) {
        throw new DomainError('CONFLICT', 'The conversation is no longer handled by the bot');
      }
      const ins = await c.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, sender_kind, body, conversation_version)
         VALUES ($1,$2,'OUT','BOT',$3,$4) RETURNING id`, [ctx.tenantId, conv.id, body, conv.version]);
      await c.query('UPDATE conversations SET last_activity_at = now() WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, conv.id]);
      await outboxSend(c, ctx.tenantId, ins.rows[0]!.id);
      return { messageId: ins.rows[0]!.id };
    });
  }

  // ---------------------------------------------------------------- handoff (RF-020..022, UC-04, RN-022)

  /** Bot or policy asks for a person: urgency, low confidence, patient request, tool failure (RF-021). */
  async requestHuman(ctx: Ctx, input: { conversationId: string; reason: string }): Promise<ConversationState> {
    return withTx(this.pool, async (c) => {
      const conv = await this.lock(c, ctx, input.conversationId);
      if (conv.mode === 'HUMAN_PENDING' || conv.mode === 'HUMAN_ACTIVE') return state(conv);
      const version = await this.setMode(c, ctx, conv, 'HUMAN_PENDING', null, input.reason.slice(0, 200));
      await audit(c, ctx, { action: 'conversation.escalated', objectType: 'conversation', objectId: conv.id, reason: input.reason.slice(0, 200) });
      return { id: conv.id, mode: 'HUMAN_PENDING', version, assignedTo: null };
    });
  }

  async takeover(ctx: Ctx, input: { conversationId: string }): Promise<ConversationState> {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 'Only a person can take over a conversation');
    const me = userRef(ctx);
    return withTx(this.pool, async (c) => {
      const conv = await this.lock(c, ctx, input.conversationId);
      if (conv.mode === 'HUMAN_ACTIVE') {
        if (conv.assigned_to === me) return state(conv); // idempotent
        throw new DomainError('CONFLICT', 'Another person is already handling this conversation');
      }
      const version = await this.setMode(c, ctx, conv, 'HUMAN_ACTIVE', me, null);
      await audit(c, ctx, { action: 'conversation.takeover', objectType: 'conversation', objectId: conv.id });
      return { id: conv.id, mode: 'HUMAN_ACTIVE', version, assignedTo: me };
    });
  }

  /** `override` lets an administrator free a conversation held by someone else. The API decides who may pass it. */
  async release(ctx: Ctx, input: { conversationId: string; override?: boolean }): Promise<ConversationState> {
    return withTx(this.pool, async (c) => {
      const conv = await this.lock(c, ctx, input.conversationId);
      if (conv.mode === 'BOT') return state(conv);
      if (conv.mode === 'HUMAN_ACTIVE' && conv.assigned_to !== userRef(ctx) && !input.override) {
        throw new DomainError('FORBIDDEN', 'Only the assigned person can release this conversation');
      }
      const version = await this.setMode(c, ctx, conv, 'BOT', null, null);
      await audit(c, ctx, { action: 'conversation.released', objectType: 'conversation', objectId: conv.id, metadata: { override: !!input.override } });
      return { id: conv.id, mode: 'BOT', version, assignedTo: null };
    });
  }

  async close(ctx: Ctx, input: { conversationId: string; override?: boolean }): Promise<ConversationState> {
    return withTx(this.pool, async (c) => {
      const conv = await this.lock(c, ctx, input.conversationId);
      if (conv.mode === 'CLOSED') return state(conv);
      if (conv.mode === 'HUMAN_ACTIVE' && conv.assigned_to !== userRef(ctx) && !input.override) {
        throw new DomainError('FORBIDDEN', 'Only the assigned person can close this conversation');
      }
      const version = await this.setMode(c, ctx, conv, 'CLOSED', null, null);
      await audit(c, ctx, { action: 'conversation.closed', objectType: 'conversation', objectId: conv.id });
      return { id: conv.id, mode: 'CLOSED', version, assignedTo: null };
    });
  }

  /** A person answers. Only the assignee can write while a conversation is HUMAN_ACTIVE (no simultaneous replies). */
  async sendHumanMessage(ctx: Ctx, input: { conversationId: string; body: string }): Promise<{ messageId: string }> {
    const body = cleanBody(input.body);
    return withTx(this.pool, async (c) => {
      const conv = await this.lock(c, ctx, input.conversationId);
      if (conv.mode !== 'HUMAN_ACTIVE' || conv.assigned_to !== userRef(ctx)) {
        throw new DomainError('CONFLICT', 'Take over the conversation before replying');
      }
      const ins = await c.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, sender_kind, body, conversation_version)
         VALUES ($1,$2,'OUT','HUMAN',$3,$4) RETURNING id`, [ctx.tenantId, conv.id, body, conv.version]);
      await c.query('UPDATE conversations SET last_activity_at = now() WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, conv.id]);
      await outboxSend(c, ctx.tenantId, ins.rows[0]!.id);
      await audit(c, ctx, { action: 'message.human_sent', objectType: 'message', objectId: ins.rows[0]!.id }); // no body in the trail
      return { messageId: ins.rows[0]!.id };
    });
  }

  // ---------------------------------------------------------------- reads

  async list(ctx: Ctx, input: { mode?: ConversationMode; limit?: number; before?: Date } = {}): Promise<ConversationSummary[]> {
    const r = await rows<{
      id: string; channel: string; external_ref: string | null; mode: ConversationMode; version: number; assigned_to: string | null;
      escalation_reason: string | null; last_activity_at: Date; full_name: string | null; phone_e164: string | null;
      last_body: string | null; last_direction: string | null; last_sender: string | null;
    }>(this.pool,
      `SELECT c.id, c.channel, c.external_ref, c.mode, c.version, c.assigned_to, c.escalation_reason, c.last_activity_at,
              p.full_name, p.phone_e164, m.body AS last_body, m.direction AS last_direction, m.sender_kind AS last_sender
         FROM conversations c
         LEFT JOIN patients p ON p.tenant_id = c.tenant_id AND p.id = c.patient_id
         LEFT JOIN LATERAL (SELECT body, direction, sender_kind FROM messages m
                             WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) m ON true
        WHERE c.tenant_id = $1 AND (($2::text IS NULL AND c.mode <> 'CLOSED') OR c.mode = $2)
          AND ($3::timestamptz IS NULL OR c.last_activity_at < $3)
        ORDER BY c.last_activity_at DESC, c.id LIMIT $4`,
      [ctx.tenantId, input.mode ?? null, input.before ?? null, Math.min(input.limit ?? 50, 100)]);
    return r.map((x) => ({
      id: x.id, channel: x.channel, mode: x.mode, version: x.version, assignedTo: x.assigned_to, escalationReason: x.escalation_reason,
      lastActivityAt: x.last_activity_at, patientName: x.full_name, patientPhone: x.phone_e164, externalRef: x.external_ref,
      lastMessage: x.last_body === null ? null : { body: x.last_body, direction: x.last_direction!, senderKind: x.last_sender! },
    }));
  }

  async get(ctx: Ctx, conversationId: string): Promise<ConversationSummary> {
    const id = need(conversationId);
    const [conv] = (await this.list(ctx, { mode: undefined, limit: 100 })).filter((x) => x.id === id);
    if (conv) return conv;
    const closed = (await this.list(ctx, { mode: 'CLOSED', limit: 100 })).find((x) => x.id === id);
    if (!closed) throw notFound();
    return closed;
  }

  async messages(ctx: Ctx, conversationId: string, limit = 200): Promise<MessageRow[]> {
    const id = need(conversationId);
    const exists = await one(this.pool, 'SELECT 1 FROM conversations WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    if (!exists) throw notFound();
    const r = await rows<{ id: string; direction: 'IN' | 'OUT'; sender_kind: string; body: string; delivery_status: string; created_at: Date; conversation_version: number }>(
      this.pool,
      `SELECT * FROM (SELECT id, direction, sender_kind, body, delivery_status, created_at, conversation_version FROM messages
                       WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3) t ORDER BY created_at, id`,
      [ctx.tenantId, id, Math.min(limit, 500)]);
    return r.map((m) => ({ id: m.id, direction: m.direction, senderKind: m.sender_kind, body: m.body, deliveryStatus: m.delivery_status, createdAt: m.created_at, conversationVersion: m.conversation_version }));
  }
}

const state = (c: ConvRow): ConversationState => ({ id: c.id, mode: c.mode, version: c.version, assignedTo: c.assigned_to });

/** Delivery is the worker's job (WhatsApp is not wired yet); the outbox row is what makes it reliable (spec 14.4). */
async function outboxSend(c: PoolClient, tenantId: string, messageId: string): Promise<void> {
  await c.query(
    `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, type, payload_min) VALUES ($1,'message',$2,'message.send_requested',$3)`,
    [tenantId, messageId, JSON.stringify({ id: messageId })]);
}

void pgCode;
