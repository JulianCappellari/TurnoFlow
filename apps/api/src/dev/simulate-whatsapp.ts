// Sends ONE signed, WhatsApp-style webhook to a local API, as the provider would. Development only (synthetic numbers).
// Usage: WHATSAPP_APP_SECRET=... tsx apps/api/src/dev/simulate-whatsapp.ts "texto" [waId] [type]
import { randomUUID } from 'node:crypto';
import { signBody } from '../whatsapp.ts';

const secret = process.env.WHATSAPP_APP_SECRET;
if (!secret) throw new Error('WHATSAPP_APP_SECRET is required');
const api = process.env.API_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(api)) throw new Error('The simulator only talks to a local API');
const [text = 'Hola, quisiera un turno', waId = '5491155550101', type = 'text'] = process.argv.slice(2);

const body = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: 'SIM', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '0', phone_number_id: process.env.PHONE_NUMBER_ID ?? 'demo-phone-1' },
    contacts: [{ profile: { name: 'Simulado' }, wa_id: waId }],
    messages: [{ from: waId, id: `wamid.sim.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type, ...(type === 'text' ? { text: { body: text } } : {}) }],
  } }] }],
});
const res = await fetch(`${api}/api/v1/webhooks/whatsapp`, {
  method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(secret, body) },
});
console.log(res.status, await res.text());
