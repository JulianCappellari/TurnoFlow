import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { MockWhatsAppSender, dispatchOutbox, processInboxEvents } from '@turnoflow/db';
import { createWorld, makePool } from '../../../packages/db/test/fixtures.ts';
import { buildApp, signBody, signSessionToken, WEBHOOK_PATH } from '../src/index.ts';
import { parseWhatsAppPayload } from '../src/whatsapp.ts';

const SECRET = 'test-secret-test-secret-test-secret-123';
const WA = { appSecret: 'wa-app-secret-0123456789abcdef', verifyToken: 'wa-verify-token-0123456789abc' };
let pool: Pool;
let app: FastifyInstance;
beforeAll(() => { pool = makePool(20); app = buildApp({ pool, authSecret: SECRET, whatsapp: WA }); });
afterAll(async () => { await app.close(); await pool.end(); });

const payload = (pn: string, opts: { from?: string; id?: string; text?: string; type?: string; statuses?: { id: string; status: string }[] } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '000', phone_number_id: pn },
    contacts: [{ profile: { name: 'Persona de prueba' }, wa_id: opts.from ?? '5491100009999' }],
    ...(opts.statuses ? { statuses: opts.statuses.map((s) => ({ ...s, timestamp: '1900000000', recipient_id: opts.from ?? '5491100009999' })) }
      : { messages: [{ from: opts.from ?? '5491100009999', id: opts.id ?? `wamid.${randomUUID()}`, timestamp: '1900000000', type: opts.type ?? 'text', text: { body: opts.text ?? 'Hola' } }] }),
  } }] }],
});

const post = (body: string | object, signature?: string | null, secret = WA.appSecret) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return app.inject({
    method: 'POST', url: WEBHOOK_PATH, payload: raw,
    headers: { 'content-type': 'application/json', ...(signature === null ? {} : { 'x-hub-signature-256': signature ?? signBody(secret, raw) }) },
  });
};
async function channel(w: { tenantId: string; clinicId: string }) {
  const pn = `pn-${randomUUID().slice(0, 12)}`;
  await pool.query(`INSERT INTO channel_accounts (tenant_id, clinic_id, provider, external_account_ref) VALUES ($1,$2,'whatsapp',$3)`, [w.tenantId, w.clinicId, pn]);
  return pn;
}
const events = async (tenantId: string) => Number((await pool.query('SELECT count(*) FROM inbox_events WHERE tenant_id = $1', [tenantId])).rows[0].count);

describe('webhook authenticity (RF-016, TC-060-style)', () => {
  it('rejects missing, malformed, wrong-secret and tampered signatures with 401 and stores nothing', async () => {
    const w = await createWorld(pool); const pn = await channel(w);
    const body = JSON.stringify(payload(pn));
    const bad = [null, 'sha256=', 'sha256=zz', 'md5=abc', signBody('another-secret-another-secret-1', body), signBody(WA.appSecret, `${body} `)];
    for (const sig of bad) {
      const r = await post(body, sig);
      expect(r.statusCode, String(sig)).toBe(401);
      expect(r.headers['content-type']).toContain('application/problem+json');
    }
    expect(await events(w.tenantId)).toBe(0);
  });

  it('accepts a correctly signed payload, stores it, and answers fast with a minimal body', async () => {
    const w = await createWorld(pool); const pn = await channel(w);
    const t0 = Date.now();
    const r = await post(payload(pn, { text: 'Quiero un turno' }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ received: 1, stored: 1 });
    expect(Date.now() - t0).toBeLessThan(1000); // RNF-007: verify + persist + ACK
    expect(await events(w.tenantId)).toBe(1);
  });

  it('a replay of the same signed payload creates no second event or message', async () => {
    const w = await createWorld(pool); const pn = await channel(w);
    const raw = JSON.stringify(payload(pn, { id: 'wamid.replay-1' + randomUUID() }));
    expect((await post(raw)).json().stored).toBe(1);
    expect((await post(raw)).json().stored).toBe(0);
    await processInboxEvents(pool, { tenantId: w.tenantId });
    expect(Number((await pool.query('SELECT count(*) FROM messages WHERE tenant_id = $1', [w.tenantId])).rows[0].count)).toBe(1);
  });

  it('valid signature over broken JSON is a 400; unknown shapes are acknowledged but ignored; huge bodies are refused', async () => {
    expect((await post('{not json')).statusCode).toBe(400);
    const ok = await post({ object: 'something_else', entry: 'nope' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ received: 0, stored: 0 });
    const big = await post(JSON.stringify({ pad: 'x'.repeat(300 * 1024) }));
    expect(big.statusCode).toBe(413);
  });

  it('a payload claiming another tenant cannot reach it: routing uses only our phone-number mapping', async () => {
    const a = await createWorld(pool); const b = await createWorld(pool);
    const pa = await channel(a);
    const forged = payload(pa); // signed, but even with fields naming B, the mapping decides
    (forged as { tenant_id?: string }).tenant_id = b.tenantId;
    await post(forged);
    expect(await events(b.tenantId)).toBe(0);
    expect(await events(a.tenantId)).toBe(1);
  });
});

describe('subscription handshake', () => {
  const get = (qs: string) => app.inject({ method: 'GET', url: `${WEBHOOK_PATH}?${qs}` });
  it('echoes the challenge only for the right token', async () => {
    const ok = await get(`hub.mode=subscribe&hub.verify_token=${WA.verifyToken}&hub.challenge=1158201444`);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');
    expect((await get('hub.mode=subscribe&hub.verify_token=wrong-wrong-wrong&hub.challenge=1')).statusCode).toBe(403);
    expect((await get('hub.mode=subscribe&hub.challenge=1')).statusCode).toBe(403);
  });
  it('the route does not exist when WhatsApp is not configured', async () => {
    const bare = buildApp({ pool, authSecret: SECRET });
    expect((await bare.inject({ method: 'POST', url: WEBHOOK_PATH, payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(404);
    await bare.close();
  });
});

describe('payload parser', () => {
  it('extracts messages and statuses, ignores malformed entries and bad sender ids', () => {
    const pn = 'pn-1';
    expect(parseWhatsAppPayload(payload(pn, { id: 'm1', text: 'hola' }))).toEqual([
      { kind: 'message', phoneNumberId: pn, waId: '5491100009999', messageId: 'm1', type: 'text', text: 'hola', profileName: 'Persona de prueba', timestamp: 1900000000 }]);
    expect(parseWhatsAppPayload(payload(pn, { statuses: [{ id: 's1', status: 'read' }, { id: 's2', status: 'weird' }] })).map((e) => e.kind === 'status' && e.status)).toEqual(['read']);
    expect(parseWhatsAppPayload(payload(pn, { from: 'not-digits' }))).toEqual([]);
    expect(parseWhatsAppPayload(null)).toEqual([]);
    expect(parseWhatsAppPayload({ entry: [null, 3, { changes: [{ value: { messages: [{}] } }] }] })).toEqual([]);
  });
});

describe('end to end with the mock provider', () => {
  it('webhook -> worker -> inbox -> human reply -> dispatcher -> delivery receipt', async () => {
    const w = await createWorld(pool); const pn = await channel(w);
    const auth = { authorization: `Bearer ${signSessionToken(SECRET, { userId: 'ana', tenantId: w.tenantId, role: 'receptionist' })}` };
    await post(payload(pn, { from: '5491100007777', text: 'Hola, ¿tienen turno hoy?' }));
    await processInboxEvents(pool, { tenantId: w.tenantId });

    const list = (await app.inject({ method: 'GET', url: '/api/v1/inbox/conversations', headers: auth })).json().items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ mode: 'BOT', lastMessage: { body: 'Hola, ¿tienen turno hoy?' } });
    const id = list[0].id as string;

    await app.inject({ method: 'POST', url: `/api/v1/inbox/conversations/${id}/takeover`, headers: auth, payload: {} });
    await app.inject({ method: 'POST', url: `/api/v1/inbox/conversations/${id}/messages`, headers: auth, payload: { body: 'Sí, hoy a las 16' } });
    const sender = new MockWhatsAppSender();
    await dispatchOutbox(pool, sender, { tenantId: w.tenantId });
    const out = sender.sent.find((s) => s.body === 'Sí, hoy a las 16');
    expect(out).toMatchObject({ phoneNumberId: pn, to: '5491100007777' });

    const thread = async () => (await app.inject({ method: 'GET', url: `/api/v1/inbox/conversations/${id}/messages`, headers: auth })).json().messages.at(-1);
    expect(await thread()).toMatchObject({ senderKind: 'HUMAN', deliveryStatus: 'SENT' });
    const pm = (await pool.query(`SELECT provider_message_id FROM messages WHERE conversation_id = $1 AND sender_kind = 'HUMAN'`, [id])).rows[0].provider_message_id as string;
    await post(payload(pn, { statuses: [{ id: pm, status: 'delivered' }] }));
    await processInboxEvents(pool, { tenantId: w.tenantId });
    expect(await thread()).toMatchObject({ deliveryStatus: 'DELIVERED' });
  });
});
