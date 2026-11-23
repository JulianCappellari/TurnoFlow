import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { isDomainError, type ErrorCode } from '@turnoflow/domain';
import { InboxService } from '../src/index.ts';
import { createWorld, ctxFor, makePool, type World } from './fixtures.ts';

let pool: Pool;
let inbox: InboxService;
beforeAll(() => { pool = makePool(30); inbox = new InboxService(pool); });
afterAll(async () => { await pool.end(); });

const as = (w: World, id: string) => ctxFor(w, { actor: { type: 'user', id } });
async function expectCode(p: Promise<unknown>, code: ErrorCode) {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err, `expected ${code}`).toBeDefined();
  expect(isDomainError(err, code), `got ${(err as Error).message}`).toBe(true);
}
async function conv(w: World) {
  const { id } = await inbox.openConversation(ctxFor(w), {
    clinicId: w.clinicId, channel: 'WHATSAPP', externalRef: `wa-${randomUUID()}`, patientId: w.patientIds[0],
  });
  return id;
}
const count = async (sql: string, p: unknown[]) => Number((await pool.query(sql, p)).rows[0].count);

describe('conversations and inbound messages (RF-017)', () => {
  it('open is find-or-create and inbound dedupes by provider message id', async () => {
    const w = await createWorld(pool);
    const ref = `wa-${randomUUID()}`;
    const a = await inbox.openConversation(ctxFor(w), { clinicId: w.clinicId, channel: 'WHATSAPP', externalRef: ref });
    const b = await inbox.openConversation(ctxFor(w), { clinicId: w.clinicId, channel: 'WHATSAPP', externalRef: ref });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    const first = await inbox.recordInbound(ctxFor(w), { conversationId: a.id, providerMessageId: 'wamid.1', body: 'Hola' });
    const again = await inbox.recordInbound(ctxFor(w), { conversationId: a.id, providerMessageId: 'wamid.1', body: 'Hola' });
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(await count('SELECT count(*) FROM messages WHERE tenant_id = $1', [w.tenantId])).toBe(1);
  });

  it('validates bodies and keeps tenants apart', async () => {
    const a = await createWorld(pool);
    const b = await createWorld(pool);
    const id = await conv(a);
    await expectCode(inbox.recordInbound(ctxFor(a), { conversationId: id, body: '   ' }), 'VALIDATION');
    await expectCode(inbox.recordInbound(ctxFor(a), { conversationId: id, body: 'x'.repeat(4001) }), 'VALIDATION');
    await expectCode(inbox.takeover(as(b, 'u1'), { conversationId: id }), 'NOT_FOUND');
    await expectCode(inbox.messages(ctxFor(b), id), 'NOT_FOUND');
    await expectCode(inbox.openConversation(ctxFor(b), { clinicId: a.clinicId, channel: 'WHATSAPP', externalRef: 'x' }), 'NOT_FOUND');
    expect(await inbox.list(ctxFor(b))).toEqual([]);
  });
});

describe('handoff (RF-020..022, UC-04, RN-022)', () => {
  it('bot -> pending -> human -> bot, bumping the version each time and auditing it', async () => {
    const w = await createWorld(pool);
    const id = await conv(w);
    const esc = await inbox.requestHuman(ctxFor(w), { conversationId: id, reason: 'paciente pidio una persona' });
    expect(esc).toMatchObject({ mode: 'HUMAN_PENDING', version: 2 });
    expect((await inbox.requestHuman(ctxFor(w), { conversationId: id, reason: 'otra vez' })).version).toBe(2); // idempotent
    const t = await inbox.takeover(as(w, 'ana'), { conversationId: id });
    expect(t).toMatchObject({ mode: 'HUMAN_ACTIVE', version: 3, assignedTo: 'user:ana' });
    expect((await inbox.takeover(as(w, 'ana'), { conversationId: id })).version).toBe(3); // same person: idempotent
    await expectCode(inbox.takeover(as(w, 'beto'), { conversationId: id }), 'CONFLICT');
    expect(await inbox.release(as(w, 'ana'), { conversationId: id })).toMatchObject({ mode: 'BOT', version: 4, assignedTo: null });
    expect(await count(`SELECT count(*) FROM audit_events WHERE tenant_id = $1 AND action LIKE 'conversation.%'`, [w.tenantId])).toBe(3);
  });

  it('only a person can take over; only the assignee (or an override) can release or close', async () => {
    const w = await createWorld(pool);
    const id = await conv(w);
    await expectCode(inbox.takeover(ctxFor(w, { actor: { type: 'agent', id: 'bot' } }), { conversationId: id }), 'FORBIDDEN');
    await inbox.takeover(as(w, 'ana'), { conversationId: id });
    await expectCode(inbox.release(as(w, 'beto'), { conversationId: id }), 'FORBIDDEN');
    await expectCode(inbox.close(as(w, 'beto'), { conversationId: id }), 'FORBIDDEN');
    expect((await inbox.release(as(w, 'beto'), { conversationId: id, override: true })).mode).toBe('BOT');
  });

  it('50 people taking over at once: exactly one wins, the rest get 409', async () => {
    const w = await createWorld(pool);
    const id = await conv(w);
    const rs = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => inbox.takeover(as(w, `u${i}`), { conversationId: id })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rs.filter((r) => r.status === 'rejected' && isDomainError(r.reason, 'CONFLICT'))).toHaveLength(49);
  });

  it('a closed conversation reopens for the bot on a new inbound message', async () => {
    const w = await createWorld(pool);
    const id = await conv(w);
    await inbox.close(as(w, 'ana'), { conversationId: id });
    expect((await inbox.list(ctxFor(w))).map((c) => c.id)).not.toContain(id);
    expect((await inbox.list(ctxFor(w), { mode: 'CLOSED' })).map((c) => c.id)).toContain(id);
    const r = await inbox.recordInbound(ctxFor(w), { conversationId: id, body: 'Hola de nuevo' });
    expect(r.version).toBe(3);
    expect((await inbox.get(ctxFor(w), id)).mode).toBe('BOT');
  });
});

describe('replies', () => {
  it('humans reply only while assigned; the reply is queued through the outbox exactly once', async () => {
    const w = await createWorld(pool);
    const id = await conv(w);
    await expectCode(inbox.sendHumanMessage(as(w, 'ana'), { conversationId: id, body: 'Hola' }), 'CONFLICT'); // not taken yet
    await inbox.takeover(as(w, 'ana'), { conversationId: id });
    await expectCode(inbox.sendHumanMessage(as(w, 'beto'), { conversationId: id, body: 'Hola' }), 'CONFLICT');
    const { messageId } = await inbox.sendHumanMessage(as(w, 'ana'), { conversationId: id, body: 'Hola, soy Ana' });
    expect(await count(
      `SELECT count(*) FROM outbox_events WHERE tenant_id = $1 AND aggregate_id = $2 AND type = 'message.send_requested'`,
      [w.tenantId, messageId])).toBe(1);
    const audit = await pool.query(`SELECT metadata FROM audit_events WHERE tenant_id = $1 AND action = 'message.human_sent'`, [w.tenantId]);
    expect(JSON.stringify(audit.rows)).not.toContain('soy Ana');
    const msgs = await inbox.messages(ctxFor(w), id);
    expect(msgs.at(-1)).toMatchObject({ senderKind: 'HUMAN', direction: 'OUT', body: 'Hola, soy Ana' });
  });
});

describe('TC-030: no automatic reply after the takeover takes effect', () => {
  it('stale bot jobs are rejected, including after a release (version changed)', async () => {
    const w = await createWorld(pool);
    const id = await conv(w);
    const v = (await inbox.recordInbound(ctxFor(w), { conversationId: id, body: 'Quiero un turno' })).version;
    await inbox.takeover(as(w, 'ana'), { conversationId: id });
    await expectCode(inbox.recordBotMessage(ctxFor(w), { conversationId: id, expectedVersion: v, body: 'respuesta tardia' }), 'CONFLICT');
    await inbox.release(as(w, 'ana'), { conversationId: id }); // back to BOT, but under a new version
    await expectCode(inbox.recordBotMessage(ctxFor(w), { conversationId: id, expectedVersion: v, body: 'respuesta tardia' }), 'CONFLICT');
    const fresh = (await inbox.get(ctxFor(w), id)).version;
    await expect(inbox.recordBotMessage(ctxFor(w), { conversationId: id, expectedVersion: fresh, body: 'ok' })).resolves.toBeDefined();
  });

  it('racing 60 bot replies against a takeover: every bot message predates the takeover, none after', async () => {
    const w = await createWorld(pool);
    const id = await conv(w);
    const v = (await inbox.recordInbound(ctxFor(w), { conversationId: id, body: 'Hola' })).version;
    const attempt = (body: string) =>
      inbox.recordBotMessage(ctxFor(w), { conversationId: id, expectedVersion: v, body }).then(() => 'sent', () => 'refused');
    const bots = Array.from({ length: 60 }, (_, i) => attempt(`bot ${i}`));
    const take = inbox.takeover(as(w, 'ana'), { conversationId: id });
    const results = await Promise.all(bots);
    const taken = await take;
    expect(taken.mode).toBe('HUMAN_ACTIVE');
    const late = await Promise.all(Array.from({ length: 20 }, () => attempt('late')));
    expect(late.every((r) => r === 'refused')).toBe(true);
    const rows = (await pool.query(`SELECT conversation_version FROM messages WHERE tenant_id = $1 AND sender_kind = 'BOT'`, [w.tenantId])).rows;
    expect(rows).toHaveLength(results.filter((r) => r === 'sent').length);
    for (const r of rows) expect(r.conversation_version).toBeLessThan(taken.version);
  });

  it('the database refuses a HUMAN_ACTIVE conversation without an assignee', async () => {
    const w = await createWorld(pool);
    const id = await conv(w);
    const err = await pool.query(`UPDATE conversations SET mode = 'HUMAN_ACTIVE' WHERE id = $1`, [id])
      .then(() => undefined, (e: { code?: string }) => e);
    expect(err?.code).toBe('23514');
  });
});
