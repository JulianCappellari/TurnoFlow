import type { Pool } from 'pg';
import { InboxService } from '../inbox/service.ts';
import { one, pgCode, rows } from '../tx.ts';

/**
 * Provider-neutral events extracted from a verified webhook. Shapes follow the WhatsApp Cloud API as the team
 * understands it today and MUST be re-validated against the provider's current documentation before real traffic (D-05).
 */
export type ChannelEvent =
  | { kind: 'message'; phoneNumberId: string; waId: string; profileName?: string; messageId: string; timestamp: number; type: string; text?: string }
  | { kind: 'status'; phoneNumberId: string; messageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; timestamp: number };

export const PROVIDER = 'whatsapp';
export const eventKey = (e: ChannelEvent): string => (e.kind === 'message' ? `msg:${e.messageId}` : `st:${e.messageId}:${e.status}`);

export interface RecordResult { stored: number; duplicates: number; unmapped: number }

interface Account { tenant_id: string; clinic_id: string }
const findAccount = (pool: Pool, phoneNumberId: string) =>
  one<Account>(pool, `SELECT tenant_id, clinic_id FROM channel_accounts WHERE provider = $1 AND external_account_ref = $2 AND status = 'ACTIVE'`, [PROVIDER, phoneNumberId]);

/**
 * Durable first step of the webhook (RF-016/017): persist and return, nothing else. The tenant comes from OUR mapping of the
 * provider account, never from the payload. Duplicate deliveries hit the (provider, event_id) unique key and are dropped.
 */
export async function recordWebhookEvents(pool: Pool, events: ChannelEvent[]): Promise<RecordResult> {
  const result: RecordResult = { stored: 0, duplicates: 0, unmapped: 0 };
  for (const e of events) {
    const account = await findAccount(pool, e.phoneNumberId);
    const r = account
      ? await pool.query(
        `INSERT INTO inbox_events (tenant_id, provider, event_id, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (provider, event_id) DO NOTHING`,
        [account.tenant_id, PROVIDER, eventKey(e), JSON.stringify(e)])
      // Unknown phone number: keep a trace without any content so operators can see misrouted traffic.
      : await pool.query(
        `INSERT INTO inbox_events (tenant_id, provider, event_id, payload, status, last_error, processed_at)
         VALUES (NULL,$1,$2,$3,'DEAD','UNMAPPED_ACCOUNT', now()) ON CONFLICT (provider, event_id) DO NOTHING`,
        [PROVIDER, eventKey(e), JSON.stringify({ kind: e.kind, phoneNumberId: e.phoneNumberId })]);
    if ((r.rowCount ?? 0) === 0) result.duplicates += 1;
    else if (account) result.stored += 1;
    else result.unmapped += 1;
  }
  return result;
}

class RetryLater extends Error { override name = 'RetryLater'; }

const STATUS_RANK = { sent: 1, delivered: 2, read: 3 } as const;
const STATUS_NAME = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' } as const;
const backoffSeconds = (attempts: number) => Math.min(5 * 2 ** attempts, 900);

export interface ProcessOptions { limit?: number; now?: Date; maxAttempts?: number; /** Only drain one tenant's events (operations, tests). */ tenantId?: string }

/**
 * Worker step: claims pending events (visibility timeout, safe with many workers), applies them through the domain services,
 * retries with exponential backoff and parks poison events as DEAD for inspection.
 */
export async function processInboxEvents(pool: Pool, opts: ProcessOptions = {}): Promise<{ done: number; retried: number; dead: number }> {
  // Without an explicit clock the database's own clock is used, so claim/backoff never mix two machines' times.
  const now = opts.now ?? null;
  const maxAttempts = opts.maxAttempts ?? 8;
  const claimed = await rows<{ id: string; tenant_id: string; payload: ChannelEvent; attempts: number; received_at: Date }>(
    pool,
    `UPDATE inbox_events SET attempts = attempts + 1, next_attempt_at = COALESCE($1::timestamptz, now()) + interval '60 seconds'
      WHERE id IN (SELECT id FROM inbox_events WHERE status = 'PENDING' AND next_attempt_at <= COALESCE($1::timestamptz, now()) AND ($3::uuid IS NULL OR tenant_id = $3) ORDER BY received_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, tenant_id, payload, attempts, received_at`,
    [now, opts.limit ?? 20, opts.tenantId ?? null]);
  claimed.sort((a, b) => a.received_at.getTime() - b.received_at.getTime());

  const out = { done: 0, retried: 0, dead: 0 };
  for (const ev of claimed) {
    try {
      if (ev.payload.kind === 'message') await handleMessage(pool, ev.tenant_id, ev.payload);
      else await handleStatus(pool, ev.tenant_id, ev.payload);
      await pool.query(`UPDATE inbox_events SET status = 'DONE', processed_at = now(), last_error = NULL WHERE id = $1`, [ev.id]);
      out.done += 1;
    } catch (e) {
      // Only an error code/class is stored: messages from drivers can echo personal data.
      const reason = (pgCode(e) ?? (e as Error).name ?? 'ERROR').slice(0, 60);
      if (ev.attempts >= maxAttempts) {
        await pool.query(`UPDATE inbox_events SET status = 'DEAD', processed_at = now(), last_error = $2 WHERE id = $1`, [ev.id, reason]);
        out.dead += 1;
      } else {
        await pool.query(
          `UPDATE inbox_events SET last_error = $2, next_attempt_at = COALESCE($3::timestamptz, now()) + make_interval(secs => $4) WHERE id = $1`,
          [ev.id, reason, now, backoffSeconds(ev.attempts)]);
        out.retried += 1;
      }
    }
  }
  return out;
}

async function handleMessage(pool: Pool, tenantId: string, e: Extract<ChannelEvent, { kind: 'message' }>): Promise<void> {
  const account = await findAccount(pool, e.phoneNumberId);
  if (!account || account.tenant_id !== tenantId) throw new Error('ACCOUNT_CHANGED');
  const ctx = { tenantId, actor: { type: 'system' as const, id: 'whatsapp-ingest' } };
  // RN-007: a phone number never authorizes anything by itself; linking is only a convenience for the receptionist.
  const patient = await one<{ id: string }>(pool, 'SELECT id FROM patients WHERE tenant_id = $1 AND phone_e164 = $2', [tenantId, `+${e.waId}`]);
  const inbox = new InboxService(pool);
  const { id } = await inbox.openConversation(ctx, { clinicId: account.clinic_id, channel: 'WHATSAPP', externalRef: e.waId, patientId: patient?.id });
  const supported = e.type === 'text' && !!e.text?.trim();
  const body = supported ? e.text!.slice(0, 4000) : `[${e.type}] Mensaje no compatible todavía`;
  const r = await inbox.recordInbound(ctx, { conversationId: id, providerMessageId: e.messageId, body });
  // Audio, images and the like are out of the P0 scope: hand them to a person instead of ignoring them (RF-021).
  if (!supported && !r.duplicate) await inbox.requestHuman(ctx, { conversationId: id, reason: 'Mensaje no compatible (audio, imagen u otro): requiere una persona' });
}

async function handleStatus(pool: Pool, tenantId: string, e: Extract<ChannelEvent, { kind: 'status' }>): Promise<void> {
  const next = STATUS_NAME[e.status];
  const r = e.status === 'failed'
    ? await pool.query(
      `UPDATE messages SET delivery_status = 'FAILED' WHERE tenant_id = $1 AND provider_message_id = $2 AND direction = 'OUT' AND delivery_status IN ('PENDING','SENT')`,
      [tenantId, e.messageId])
    : await pool.query(
      `UPDATE messages SET delivery_status = $3 WHERE tenant_id = $1 AND provider_message_id = $2 AND direction = 'OUT'
          AND (CASE delivery_status WHEN 'PENDING' THEN 0 WHEN 'SENT' THEN 1 WHEN 'DELIVERED' THEN 2 WHEN 'READ' THEN 3 ELSE 9 END) < $4`,
      [tenantId, e.messageId, next, STATUS_RANK[e.status]]);
  if ((r.rowCount ?? 0) > 0) return;
  // Nothing changed: either the status is stale/out of order (fine) or we do not know the message yet (retry).
  const known = await one(pool, `SELECT 1 FROM messages WHERE tenant_id = $1 AND provider_message_id = $2`, [tenantId, e.messageId]);
  if (!known) throw new RetryLater('MESSAGE_NOT_FOUND');
}
