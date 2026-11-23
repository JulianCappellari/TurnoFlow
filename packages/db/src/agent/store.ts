import type { ConversationMode } from '@turnoflow/domain';
import type { Pool, PoolClient } from 'pg';
import { isUuid, one, rows } from '../tx.ts';

/** Persistence used by the AI agent. All SQL stays in this package; the agent only sees these functions. */
export interface AgentConversation {
  id: string; clinicId: string; patientId: string | null; mode: ConversationMode; version: number;
  agentState: Record<string, unknown>;
  clinic: { name: string; timezone: string; agentEnabled: boolean; cancellationNoticeMin: number; bookingMinNoticeMin: number };
}
export interface AgentMessage { id: string; direction: 'IN' | 'OUT'; senderKind: string; body: string; createdAt: Date }

export async function getConversationForAgent(pool: Pool, tenantId: string, conversationId: string): Promise<AgentConversation | null> {
  if (!isUuid(conversationId)) return null;
  const r = await one<{
    id: string; clinic_id: string; patient_id: string | null; mode: ConversationMode; version: number; agent_state: Record<string, unknown>;
    name: string; timezone: string; agent_enabled: boolean; cancellation_notice_min: number; booking_min_notice_min: number;
  }>(pool,
    `SELECT c.id, c.clinic_id, c.patient_id, c.mode, c.version, c.agent_state, k.name, k.timezone, k.agent_enabled, k.cancellation_notice_min, k.booking_min_notice_min
       FROM conversations c JOIN clinics k ON k.tenant_id = c.tenant_id AND k.id = c.clinic_id
      WHERE c.tenant_id = $1 AND c.id = $2`, [tenantId, conversationId]);
  if (!r) return null;
  return {
    id: r.id, clinicId: r.clinic_id, patientId: r.patient_id, mode: r.mode, version: r.version, agentState: r.agent_state ?? {},
    clinic: { name: r.name, timezone: r.timezone, agentEnabled: r.agent_enabled, cancellationNoticeMin: r.cancellation_notice_min, bookingMinNoticeMin: r.booking_min_notice_min },
  };
}

export async function recentMessages(pool: Pool, tenantId: string, conversationId: string, limit = 12): Promise<AgentMessage[]> {
  const r = await rows<{ id: string; direction: 'IN' | 'OUT'; sender_kind: string; body: string; created_at: Date }>(pool,
    `SELECT * FROM (SELECT id, direction, sender_kind, body, created_at FROM messages
                     WHERE tenant_id = $1 AND conversation_id = $2 AND delivery_status <> 'SUPPRESSED'
                     ORDER BY created_at DESC, id DESC LIMIT $3) t ORDER BY created_at, id`, [tenantId, conversationId, limit]);
  return r.map((m) => ({ id: m.id, direction: m.direction, senderKind: m.sender_kind, body: m.body, createdAt: m.created_at }));
}

export async function latestInboundId(pool: Pool, tenantId: string, conversationId: string): Promise<string | null> {
  return (await one<{ id: string }>(pool,
    `SELECT id FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'IN' ORDER BY created_at DESC, id DESC LIMIT 1`,
    [tenantId, conversationId]))?.id ?? null;
}

/** Counted against the database clock, the same one that stamps messages. */
export async function countBotMessagesLast(pool: Pool, tenantId: string, conversationId: string, seconds: number): Promise<number> {
  const r = await one<{ n: string }>(pool,
    `SELECT count(*) AS n FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND sender_kind = 'BOT' AND created_at >= now() - make_interval(secs => $3)`, [tenantId, conversationId, seconds]);
  return Number(r?.n ?? 0);
}

/** Returns null when this inbound message already has a run (a repeated job must not answer twice). */
export async function startRun(pool: Pool, input: { tenantId: string; conversationId: string; inboundMessageId: string; promptVersion: string }): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO agent_runs (tenant_id, conversation_id, inbound_message_id, prompt_version) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, inbound_message_id) DO NOTHING RETURNING id`,
    [input.tenantId, input.conversationId, input.inboundMessageId, input.promptVersion]);
  return r.rows[0]?.id ?? null;
}

export async function finishRun(pool: Pool, runId: string, r: { status: 'DONE' | 'SKIPPED' | 'FAILED'; outcome: string; llmCalls: number; toolCalls: number }): Promise<void> {
  await pool.query(
    `UPDATE agent_runs SET status = $2, outcome = $3, llm_calls = $4, tool_calls = $5, finished_at = now() WHERE id = $1`,
    [runId, r.status, r.outcome.slice(0, 60), r.llmCalls, r.toolCalls]);
}

export async function saveAgentState(pool: Pool, tenantId: string, conversationId: string, state: unknown): Promise<void> {
  await pool.query('UPDATE conversations SET agent_state = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, conversationId, JSON.stringify(state)]);
}

/** Weekly hours of the clinic's active professionals, for the approved-policy tool. */
export async function weeklyHours(pool: Pool, tenantId: string, clinicId: string) {
  return rows<{ professional: string; weekday: number; start_minute: number; end_minute: number }>(pool,
    `SELECT p.name AS professional, s.weekday, s.start_minute, s.end_minute
       FROM schedules s JOIN professionals p ON p.tenant_id = s.tenant_id AND p.id = s.professional_id
      WHERE s.tenant_id = $1 AND p.clinic_id = $2 AND p.active ORDER BY p.name, s.weekday, s.start_minute`, [tenantId, clinicId]);
}

/** One advisory lock per conversation, held on its own connection for the whole agent run (an LLM call must not hold a transaction). */
export async function tryLockConversation(pool: Pool, tenantId: string, conversationId: string): Promise<(() => Promise<void>) | null> {
  const client: PoolClient = await pool.connect();
  const key = `agent:${tenantId}:${conversationId}`;
  try {
    const r = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [key]);
    if (!r.rows[0]!.ok) { client.release(); return null; }
  } catch (e) { client.release(); throw e; }
  return async () => {
    try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]); } finally { client.release(); }
  };
}

/** Claims `agent.inbound` jobs from the outbox (same visibility-timeout pattern as the other queues). */
export async function claimAgentJobs(pool: Pool, opts: { limit?: number; now?: Date; tenantId?: string } = {}) {
  return rows<{ id: string; tenant_id: string; aggregate_id: string; payload_min: { conversationId?: string }; attempts: number }>(pool,
    `UPDATE outbox_events SET attempts = attempts + 1, next_attempt_at = COALESCE($1::timestamptz, now()) + interval '60 seconds'
      WHERE id IN (SELECT id FROM outbox_events WHERE type = 'agent.inbound' AND dispatched_at IS NULL AND next_attempt_at <= COALESCE($1::timestamptz, now())
                    AND ($3::uuid IS NULL OR tenant_id = $3) ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, tenant_id, aggregate_id, payload_min, attempts`, [opts.now ?? null, opts.limit ?? 10, opts.tenantId ?? null]);
}

export async function completeAgentJob(pool: Pool, id: string, error?: string): Promise<void> {
  await pool.query('UPDATE outbox_events SET dispatched_at = now(), last_error = $2 WHERE id = $1', [id, error ?? null]);
}

export async function retryAgentJob(pool: Pool, id: string, error: string, delaySeconds: number, now?: Date): Promise<void> {
  await pool.query(`UPDATE outbox_events SET last_error = $2, next_attempt_at = COALESCE($4::timestamptz, now()) + make_interval(secs => $3) WHERE id = $1`,
    [id, error.slice(0, 60), delaySeconds, now ?? null]);
}
