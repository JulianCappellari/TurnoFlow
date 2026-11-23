import type { Pool } from 'pg';
import { PermanentSendError, type WhatsAppSender } from './provider.ts';
import { PROVIDER } from './ingest.ts';
import { one, rows } from '../tx.ts';

const backoffSeconds = (attempts: number) => Math.min(5 * 2 ** attempts, 900);

export interface DispatchOptions { limit?: number; now?: Date; maxAttempts?: number; /** Only dispatch one tenant's messages (operations, tests). */ tenantId?: string }
export interface DispatchResult { sent: number; suppressed: number; failed: number; retried: number; skipped: number }

/**
 * Transactional-outbox consumer for `message.send_requested`. At-least-once: a crash between the provider call and the
 * database update re-sends after the visibility timeout, which is why the message id travels as an idempotency key.
 * A bot message is checked against the conversation just before sending (spec 13.4); a message a provider has already
 * accepted cannot be withdrawn (UC-04 limit).
 */
export async function dispatchOutbox(pool: Pool, sender: WhatsAppSender, opts: DispatchOptions = {}): Promise<DispatchResult> {
  // Without an explicit clock the database's own clock is used (see processInboxEvents).
  const now = opts.now ?? null;
  const maxAttempts = opts.maxAttempts ?? 6;
  const claimed = await rows<{ id: string; tenant_id: string; aggregate_id: string; attempts: number }>(
    pool,
    `UPDATE outbox_events SET attempts = attempts + 1, next_attempt_at = COALESCE($1::timestamptz, now()) + interval '60 seconds'
      WHERE id IN (SELECT id FROM outbox_events WHERE type = 'message.send_requested' AND dispatched_at IS NULL AND next_attempt_at <= COALESCE($1::timestamptz, now())
                    AND ($3::uuid IS NULL OR tenant_id = $3) ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, tenant_id, aggregate_id, attempts`,
    [now, opts.limit ?? 20, opts.tenantId ?? null]);

  const res: DispatchResult = { sent: 0, suppressed: 0, failed: 0, retried: 0, skipped: 0 };
  const finish = (id: string, error?: string) =>
    pool.query('UPDATE outbox_events SET dispatched_at = now(), last_error = $2 WHERE id = $1', [id, error ?? null]);
  const setStatus = (tenantId: string, messageId: string, status: string) =>
    pool.query(`UPDATE messages SET delivery_status = $3 WHERE tenant_id = $1 AND id = $2 AND delivery_status = 'PENDING'`, [tenantId, messageId, status]);

  for (const ev of claimed) {
    const m = await one<{
      body: string; sender_kind: string; delivery_status: string; conversation_version: number;
      mode: string; version: number; external_ref: string | null; clinic_id: string; channel: string;
    }>(pool,
      `SELECT m.body, m.sender_kind, m.delivery_status, m.conversation_version, c.mode, c.version, c.external_ref, c.clinic_id, c.channel
         FROM messages m JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
        WHERE m.tenant_id = $1 AND m.id = $2`, [ev.tenant_id, ev.aggregate_id]);
    if (!m) { await finish(ev.id, 'MESSAGE_NOT_FOUND'); res.skipped += 1; continue; }
    if (m.delivery_status !== 'PENDING') { await finish(ev.id); res.skipped += 1; continue; }

    if (m.sender_kind === 'BOT' && (m.mode !== 'BOT' || m.version !== m.conversation_version)) {
      await setStatus(ev.tenant_id, ev.aggregate_id, 'SUPPRESSED');
      await finish(ev.id, 'SUPERSEDED');
      res.suppressed += 1; continue;
    }
    const account = m.channel === 'WHATSAPP' && m.external_ref
      ? await one<{ external_account_ref: string }>(pool,
        `SELECT external_account_ref FROM channel_accounts WHERE tenant_id = $1 AND clinic_id = $2 AND provider = $3 AND status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
        [ev.tenant_id, m.clinic_id, PROVIDER])
      : undefined;
    if (!account || !m.external_ref) {
      await setStatus(ev.tenant_id, ev.aggregate_id, 'FAILED');
      await finish(ev.id, 'NO_CHANNEL_ACCOUNT');
      res.failed += 1; continue;
    }

    try {
      const { providerMessageId } = await sender.sendText({ phoneNumberId: account.external_account_ref, to: m.external_ref, body: m.body, idempotencyKey: ev.aggregate_id });
      await pool.query(
        `UPDATE messages SET delivery_status = 'SENT', provider_message_id = $3 WHERE tenant_id = $1 AND id = $2 AND delivery_status = 'PENDING'`,
        [ev.tenant_id, ev.aggregate_id, providerMessageId]);
      await finish(ev.id);
      res.sent += 1;
    } catch (e) {
      if (e instanceof PermanentSendError || ev.attempts >= maxAttempts) {
        await setStatus(ev.tenant_id, ev.aggregate_id, 'FAILED');
        await finish(ev.id, e instanceof PermanentSendError ? 'PERMANENT' : 'RETRIES_EXHAUSTED');
        res.failed += 1;
      } else {
        await pool.query(
          `UPDATE outbox_events SET last_error = $2, next_attempt_at = COALESCE($3::timestamptz, now()) + make_interval(secs => $4) WHERE id = $1`,
          [ev.id, ((e as Error).name ?? 'ERROR').slice(0, 60), now, backoffSeconds(ev.attempts)]);
        res.retried += 1;
      }
    }
  }
  return res;
}
