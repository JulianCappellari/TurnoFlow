import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { recordWebhookEvents, type ChannelEvent } from '@turnoflow/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

export interface WhatsAppConfig {
  /** Meta app secret: signs every webhook body. Never stored in the database. */
  appSecret: string;
  /** Shared string used once, when the provider verifies the callback URL. */
  verifyToken: string;
}

export const WEBHOOK_PATH = '/api/v1/webhooks/whatsapp';
const MAX_BODY = 256 * 1024;

/** `sha256=<hex>` over the exact bytes received. Exported for the simulator and tests. */
export const signBody = (secret: string, body: Buffer | string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export function verifySignature(secret: string, body: Buffer, header: unknown): boolean {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const sameSecret = (a: string, b: string): boolean =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

const STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length < 512 ? v : undefined);

/**
 * Extracts the events we understand from a WhatsApp Cloud API style payload (entry[].changes[].value). Anything else is ignored.
 * The shape is the team's current understanding and must be re-validated against the provider's documentation (D-05).
 */
export function parseWhatsAppPayload(json: unknown): ChannelEvent[] {
  const out: ChannelEvent[] = [];
  if (!isObj(json)) return out;
  for (const entry of arr(json.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || !isObj(change.value)) continue;
      const v = change.value;
      const phoneNumberId = isObj(v.metadata) ? str(v.metadata.phone_number_id) : undefined;
      if (!phoneNumberId) continue;
      const names = new Map<string, string>();
      for (const c of arr(v.contacts)) if (isObj(c) && str(c.wa_id) && isObj(c.profile) && str(c.profile.name)) names.set(c.wa_id as string, c.profile.name as string);
      for (const m of arr(v.messages)) {
        if (!isObj(m)) continue;
        const messageId = str(m.id); const waId = str(m.from); const type = str(m.type);
        if (!messageId || !waId || !type || !/^\d{6,15}$/.test(waId)) continue;
        out.push({
          kind: 'message', phoneNumberId, waId, messageId, type, profileName: names.get(waId),
          timestamp: Number(m.timestamp) || 0,
          text: isObj(m.text) && typeof m.text.body === 'string' ? m.text.body : undefined,
        });
      }
      for (const s of arr(v.statuses)) {
        if (!isObj(s)) continue;
        const messageId = str(s.id); const status = str(s.status);
        if (!messageId || !status || !STATUSES.has(status)) continue;
        out.push({ kind: 'status', phoneNumberId, messageId, status: status as 'sent', timestamp: Number(s.timestamp) || 0 });
      }
    }
  }
  return out;
}

function problem(reply: FastifyReply, req: FastifyRequest, status: number, title: string, detail: string) {
  return reply.status(status).header('content-type', 'application/problem+json').send({
    type: `https://turnoflow.dev/problems/${title.toLowerCase().replace(/_/g, '-')}`, title, status, detail,
    instance: req.url.split('?')[0], correlationId: req.correlationId,
  });
}

/**
 * Public, signed endpoint (spec §12). Order matters: verify the HMAC over the raw bytes first, then parse, then persist and
 * answer. No business logic runs here: a worker applies the stored events (RF-016, RNF-007).
 */
export function registerWhatsAppWebhook(app: FastifyInstance, pool: Pool, cfg: WhatsAppConfig): void {
  void app.register(async (scope) => {
    // Raw bytes are needed to check the signature, so this scope does not use the default JSON parser.
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: MAX_BODY }, (_req, body, done) => done(null, body));

    // One-time subscription handshake.
    scope.get(WEBHOOK_PATH, async (req, reply) => {
      const q = req.query as Record<string, unknown>;
      if (q['hub.mode'] === 'subscribe' && typeof q['hub.verify_token'] === 'string' && typeof q['hub.challenge'] === 'string'
        && sameSecret(q['hub.verify_token'], cfg.verifyToken)) {
        return reply.type('text/plain').send(q['hub.challenge']);
      }
      return problem(reply, req, 403, 'FORBIDDEN', 'Verification failed');
    });

    scope.post(WEBHOOK_PATH, { bodyLimit: MAX_BODY }, async (req, reply) => {
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !verifySignature(cfg.appSecret, raw, req.headers['x-hub-signature-256'])) {
        req.log.warn({ correlationId: req.correlationId }, 'webhook rejected: invalid signature'); // never log the body
        return problem(reply, req, 401, 'INVALID_SIGNATURE', 'Signature verification failed');
      }
      let json: unknown;
      try { json = JSON.parse(raw.toString('utf8')); } catch { return problem(reply, req, 400, 'INVALID_JSON', 'Body is not valid JSON'); }
      const events = parseWhatsAppPayload(json);
      const r = await recordWebhookEvents(pool, events);
      return reply.status(200).send({ received: events.length, stored: r.stored });
    });
  });
}
