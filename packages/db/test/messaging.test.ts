import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  InboxService, MockWhatsAppSender, PermanentSendError, dispatchOutbox, processInboxEvents, recordWebhookEvents,
  type ChannelEvent,
} from '../src/index.ts';
import { createWorld, ctxFor, makePool, type World } from './fixtures.ts';

let pool: Pool;
let inbox: InboxService;
beforeAll(() => { pool = makePool(30); inbox = new InboxService(pool); });
afterAll(async () => { await pool.end(); });

const user = (w: World, id: string) => ctxFor(w, { actor: { type: 'user', id } });
const FAR = () => new Date(Date.now() + 3600_000); // lets tests skip backoff waits

async function withChannel(w: World): Promise<string> {
  const phoneNumberId = `pn-${randomUUID().slice(0, 12)}`;
  await pool.query(`INSERT INTO channel_accounts (tenant_id, clinic_id, provider, external_account_ref) VALUES ($1,$2,'whatsapp',$3)`, [w.tenantId, w.clinicId, phoneNumberId]);
  return phoneNumberId;
}
const msg = (pn: string, waId: string, text = 'Hola', id = `wamid.${randomUUID()}`): ChannelEvent =>
  ({ kind: 'message', phoneNumberId: pn, waId, messageId: id, timestamp: 1_900_000_000, type: 'text', text });
const unsupported = (pn: string, waId: string, type: string): ChannelEvent =>
  ({ kind: 'message', phoneNumberId: pn, waId, messageId: `wamid.${randomUUID()}`, timestamp: 1_900_000_000, type });
const status = (pn: string, id: string, s: 'sent' | 'delivered' | 'read' | 'failed'): ChannelEvent =>
  ({ kind: 'status', phoneNumberId: pn, messageId: id, status: s, timestamp: 1_900_000_001 });
const n = async (sql: string, p: unknown[]) => Number((await pool.query(sql, p)).rows[0].count);

describe('webhook ingestion (RF-016/017)', () => {
  it('stores events once, routes by our channel mapping, and a worker turns them into one conversation message', async () => {
    const w = await createWorld(pool);
    const pn = await withChannel(w);
    const ev = msg(pn, '5491100000001', 'Hola, quiero un turno');
    expect(await recordWebhookEvents(pool, [ev])).toEqual({ stored: 1, duplicates: 0, unmapped: 0 });
    expect(await recordWebhookEvents(pool, [ev])).toEqual({ stored: 0, duplicates: 1, unmapped: 0 }); // provider retry
    expect((await processInboxEvents(pool, { tenantId: w.tenantId })).done).toBeGreaterThanOrEqual(1);
    const list = await inbox.list(ctxFor(w));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ mode: 'BOT', externalRef: '5491100000001', lastMessage: { body: 'Hola, quiero un turno', direction: 'IN' } });
    expect(await n('SELECT count(*) FROM messages WHERE tenant_id = $1', [w.tenantId])).toBe(1);
  });

  it('a duplicate that slips past the event table is still absorbed by the message id', async () => {
    const w = await createWorld(pool);
    const pn = await withChannel(w);
    const id = `wamid.${randomUUID()}`;
    await recordWebhookEvents(pool, [msg(pn, '5491100000002', 'Uno', id)]);
    await processInboxEvents(pool, { tenantId: w.tenantId });
    await pool.query(`INSERT INTO inbox_events (tenant_id, provider, event_id, payload) VALUES ($1,'whatsapp',$2,$3)`, [w.tenantId, `other-key-${id}`, JSON.stringify(msg(pn, '5491100000002', 'Uno', id))]);
    await processInboxEvents(pool, { tenantId: w.tenantId });
    expect(await n('SELECT count(*) FROM messages WHERE tenant_id = $1', [w.tenantId])).toBe(1);
  });

  it('links a known patient by phone, never trusting payload claims about tenants', async () => {
    const w = await createWorld(pool, { patients: 0 });
    const pn = await withChannel(w);
    const { rows: [p] } = await pool.query(`INSERT INTO patients (tenant_id, full_name, phone_e164) VALUES ($1,'Paciente Uno','+5491155559999') RETURNING id`, [w.tenantId]);
    await recordWebhookEvents(pool, [msg(pn, '5491155559999')]);
    await processInboxEvents(pool, { tenantId: w.tenantId });
    expect((await inbox.list(ctxFor(w)))[0]).toMatchObject({ patientName: 'Paciente Uno' });
    void p;
  });

  it('unknown phone numbers are recorded without content and never reach a tenant', async () => {
    const w = await createWorld(pool);
    const id = `wamid.${randomUUID()}`;
    const r = await recordWebhookEvents(pool, [msg(`unknown-${randomUUID()}`, '5491100000003', 'texto privado', id)]);
    expect(r.unmapped).toBe(1);
    const stored = await pool.query(`SELECT tenant_id, status, payload FROM inbox_events WHERE event_id = $1`, [`msg:${id}`]);
    expect(stored.rows[0]).toMatchObject({ tenant_id: null, status: 'DEAD' });
    expect(JSON.stringify(stored.rows[0].payload)).not.toContain('texto privado');
    expect(await inbox.list(ctxFor(w))).toEqual([]);
  });

  it('two tenants with the same patient number stay separate', async () => {
    const a = await createWorld(pool); const b = await createWorld(pool);
    const pa = await withChannel(a); const pb = await withChannel(b);
    await recordWebhookEvents(pool, [msg(pa, '5491100000004', 'para A'), msg(pb, '5491100000004', 'para B')]);
    await processInboxEvents(pool, { tenantId: a.tenantId });
    await processInboxEvents(pool, { tenantId: b.tenantId });
    expect((await inbox.list(ctxFor(a))).map((c) => c.lastMessage?.body)).toEqual(['para A']);
    expect((await inbox.list(ctxFor(b))).map((c) => c.lastMessage?.body)).toEqual(['para B']);
  });

  it('audio and other unsupported types are stored as a placeholder and escalated to a person', async () => {
    const w = await createWorld(pool);
    const pn = await withChannel(w);
    await recordWebhookEvents(pool, [unsupported(pn, '5491100000005', 'audio')]);
    await processInboxEvents(pool, { tenantId: w.tenantId });
    const c = (await inbox.list(ctxFor(w)))[0]!;
    expect(c.mode).toBe('HUMAN_PENDING');
    expect(c.escalationReason).toContain('no compatible');
    expect(c.lastMessage?.body).toContain('[audio]');
  });

  it('concurrent workers process each event exactly once', async () => {
    const w = await createWorld(pool);
    const pn = await withChannel(w);
    await recordWebhookEvents(pool, Array.from({ length: 30 }, (_, i) => msg(pn, `54911000100${String(i).padStart(2, '0')}`, `m${i}`)));
    await Promise.all(Array.from({ length: 6 }, () => processInboxEvents(pool, { limit: 10, tenantId: w.tenantId })));
    await processInboxEvents(pool, { limit: 50, tenantId: w.tenantId });
    expect(await n('SELECT count(*) FROM messages WHERE tenant_id = $1', [w.tenantId])).toBe(30);
    expect(await n(`SELECT count(*) FROM inbox_events WHERE tenant_id = $1 AND status = 'DONE'`, [w.tenantId])).toBe(30);
  });
});

describe('delivery receipts (status events)', () => {
  async function sentMessage(w: World, pn: string) {
    const sender = new MockWhatsAppSender();
    await recordWebhookEvents(pool, [msg(pn, '5491100000010')]);
    await processInboxEvents(pool, { tenantId: w.tenantId });
    const id = (await inbox.list(ctxFor(w)))[0]!.id;
    await inbox.takeover(user(w, 'ana'), { conversationId: id });
    const { messageId } = await inbox.sendHumanMessage(user(w, 'ana'), { conversationId: id, body: 'Respuesta' });
    await dispatchOutbox(pool, sender, { tenantId: w.tenantId });
    const pm = (await pool.query('SELECT provider_message_id FROM messages WHERE id = $1', [messageId])).rows[0].provider_message_id as string;
    return { messageId, pm };
  }
  const state = async (id: string) => (await pool.query('SELECT delivery_status FROM messages WHERE id = $1', [id])).rows[0].delivery_status as string;

  it('moves forward only, ignoring late or out-of-order receipts (spec 14.4 logical order)', async () => {
    const w = await createWorld(pool); const pn = await withChannel(w);
    const { messageId, pm } = await sentMessage(w, pn);
    expect(await state(messageId)).toBe('SENT');
    await recordWebhookEvents(pool, [status(pn, pm, 'read'), status(pn, pm, 'delivered')]);
    await processInboxEvents(pool, { tenantId: w.tenantId });
    expect(await state(messageId)).toBe('READ'); // "delivered" arrived after "read" and did not regress it
    await recordWebhookEvents(pool, [status(pn, pm, 'failed')]);
    await processInboxEvents(pool, { tenantId: w.tenantId });
    expect(await state(messageId)).toBe('READ'); // a delivered/read message cannot become failed
  });

  it('a receipt for a message we cannot find yet is retried, then parked after the retry budget', async () => {
    const w = await createWorld(pool); const pn = await withChannel(w);
    const id = `wamid.${randomUUID()}`;
    await recordWebhookEvents(pool, [status(pn, id, 'delivered')]);
    expect((await processInboxEvents(pool, { tenantId: w.tenantId })).retried).toBeGreaterThanOrEqual(1);
    const row = async () => (await pool.query(`SELECT status, attempts, last_error FROM inbox_events WHERE event_id = $1`, [`st:${id}:delivered`])).rows[0];
    expect(await row()).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'RetryLater' });
    for (let i = 1; i <= 6; i++) await processInboxEvents(pool, { now: new Date(Date.now() + i * 7200_000), maxAttempts: 3, tenantId: w.tenantId }); // clock advances past each backoff
    expect(await row()).toMatchObject({ status: 'DEAD', attempts: 3 });
  });
});

describe('outbound dispatch', () => {
  async function pendingHumanMessage(w: World) {
    const { id } = await inbox.openConversation(ctxFor(w), { clinicId: w.clinicId, channel: 'WHATSAPP', externalRef: '5491100000020' });
    await inbox.takeover(user(w, 'ana'), { conversationId: id });
    const { messageId } = await inbox.sendHumanMessage(user(w, 'ana'), { conversationId: id, body: 'Hola desde recepción' });
    return { id, messageId };
  }
  const row = async (id: string) => (await pool.query('SELECT delivery_status, provider_message_id FROM messages WHERE id = $1', [id])).rows[0];

  it('sends a human reply once and records the provider id', async () => {
    const w = await createWorld(pool); const pn = await withChannel(w);
    const { messageId } = await pendingHumanMessage(w);
    const sender = new MockWhatsAppSender();
    const r = await dispatchOutbox(pool, sender, { tenantId: w.tenantId });
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(sender.sent.filter((s) => s.idempotencyKey === messageId)).toEqual([
      { phoneNumberId: pn, to: '5491100000020', body: 'Hola desde recepción', idempotencyKey: messageId }]);
    expect(await row(messageId)).toMatchObject({ delivery_status: 'SENT', provider_message_id: expect.stringContaining('wamid.mock') });
    await dispatchOutbox(pool, sender, { tenantId: w.tenantId });
    expect(sender.sent.filter((s) => s.idempotencyKey === messageId)).toHaveLength(1);
  });

  it('TC-030 at delivery: a queued bot message is suppressed if a person took over before it left', async () => {
    const w = await createWorld(pool); await withChannel(w);
    const { id } = await inbox.openConversation(ctxFor(w), { clinicId: w.clinicId, channel: 'WHATSAPP', externalRef: '5491100000021' });
    const v = (await inbox.recordInbound(ctxFor(w), { conversationId: id, body: 'Hola' })).version;
    const { messageId } = await inbox.recordBotMessage(ctxFor(w), { conversationId: id, expectedVersion: v, body: 'respuesta automática' });
    await inbox.takeover(user(w, 'ana'), { conversationId: id }); // happens before the worker picks it up
    const sender = new MockWhatsAppSender();
    const r = await dispatchOutbox(pool, sender, { tenantId: w.tenantId });
    expect(r.suppressed).toBeGreaterThanOrEqual(1);
    expect(sender.sent.find((s) => s.idempotencyKey === messageId)).toBeUndefined();
    expect((await row(messageId)).delivery_status).toBe('SUPPRESSED');
  });

  it('retries transient errors with backoff and then succeeds; gives up after the budget', async () => {
    const w = await createWorld(pool); await withChannel(w);
    const { messageId } = await pendingHumanMessage(w);
    const sender = new MockWhatsAppSender();
    sender.failures = [new Error('timeout')];
    expect((await dispatchOutbox(pool, sender, { tenantId: w.tenantId })).retried).toBeGreaterThanOrEqual(1);
    expect((await row(messageId)).delivery_status).toBe('PENDING');
    expect((await dispatchOutbox(pool, sender, { tenantId: w.tenantId })).sent).toBe(0); // still inside the backoff window
    await dispatchOutbox(pool, sender, { now: FAR(), tenantId: w.tenantId });
    expect((await row(messageId)).delivery_status).toBe('SENT');

    const w2 = await createWorld(pool); await withChannel(w2);
    const { messageId: m2 } = await pendingHumanMessage(w2);
    const flaky = new MockWhatsAppSender();
    flaky.failures = Array.from({ length: 10 }, () => new Error('down'));
    for (let i = 0; i < 4; i++) await dispatchOutbox(pool, flaky, { now: new Date(Date.now() + (i + 1) * 3600_000), maxAttempts: 3, tenantId: w2.tenantId });
    expect((await row(m2)).delivery_status).toBe('FAILED');
    const ev = await pool.query(`SELECT last_error, dispatched_at FROM outbox_events WHERE aggregate_id = $1`, [m2]);
    expect(ev.rows[0].last_error).toBe('RETRIES_EXHAUSTED');
  });

  it('permanent provider errors fail immediately; missing channel accounts fail without calling the provider', async () => {
    const w = await createWorld(pool); await withChannel(w);
    const { messageId } = await pendingHumanMessage(w);
    const sender = new MockWhatsAppSender();
    sender.failures = [new PermanentSendError('invalid recipient')];
    await dispatchOutbox(pool, sender, { tenantId: w.tenantId });
    expect((await row(messageId)).delivery_status).toBe('FAILED');

    const w2 = await createWorld(pool); // no channel account
    const { messageId: m2 } = await pendingHumanMessage(w2);
    const untouched = new MockWhatsAppSender();
    await dispatchOutbox(pool, untouched, { tenantId: w2.tenantId });
    expect((await row(m2)).delivery_status).toBe('FAILED');
    expect(untouched.sent.find((s) => s.idempotencyKey === m2)).toBeUndefined();
  });

  it('concurrent dispatchers send each message once', async () => {
    const w = await createWorld(pool); await withChannel(w);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const { id } = await inbox.openConversation(ctxFor(w), { clinicId: w.clinicId, channel: 'WHATSAPP', externalRef: `54911000300${String(i).padStart(2, '0')}` });
      await inbox.takeover(user(w, 'ana'), { conversationId: id });
      ids.push((await inbox.sendHumanMessage(user(w, 'ana'), { conversationId: id, body: `m${i}` })).messageId);
    }
    const sender = new MockWhatsAppSender();
    await Promise.all(Array.from({ length: 6 }, () => dispatchOutbox(pool, sender, { limit: 5, tenantId: w.tenantId })));
    await dispatchOutbox(pool, sender, { limit: 50, tenantId: w.tenantId });
    for (const id of ids) expect(sender.sent.filter((s) => s.idempotencyKey === id)).toHaveLength(1);
  });
});
