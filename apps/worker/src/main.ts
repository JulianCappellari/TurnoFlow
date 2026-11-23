// Background worker: applies stored webhook events and delivers queued outbound messages.
// Safe to run in several copies: both steps claim rows with FOR UPDATE SKIP LOCKED.
import { Pool } from 'pg';
import { RuleBasedMockLlm, runAgentJobs } from '@turnoflow/ai-policy';
import { SchedulingService, MockWhatsAppSender, dispatchOutbox, processInboxEvents, type OutboundText, type WhatsAppSender } from '@turnoflow/db';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const provider = process.env.WHATSAPP_PROVIDER ?? 'mock';
if (provider !== 'mock') throw new Error(`WHATSAPP_PROVIDER=${provider} is not implemented yet: only "mock" exists (no real integrations)`);

/** Mock sender that logs only metadata, never message text or full phone numbers. */
class LoggingMock extends MockWhatsAppSender {
  override async sendText(msg: OutboundText) {
    const r = await super.sendText(msg);
    console.log(`[mock-whatsapp] sent ${msg.body.length} chars to ***${msg.to.slice(-4)} -> ${r.providerMessageId}`);
    this.sent.length = 0; // do not grow forever
    return r;
  }
}

const llmKind = process.env.AGENT_LLM ?? 'mock';
if (llmKind !== 'mock') throw new Error(`AGENT_LLM=${llmKind} is not implemented: only the rule-based "mock" exists (no real model is connected)`);
const llm = new RuleBasedMockLlm();

const pool = new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 5) });
const sender: WhatsAppSender = new LoggingMock();
const scheduling = new SchedulingService(pool);
const every = Number(process.env.WORKER_INTERVAL_MS ?? 1000);
let running = true;
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const i = await processInboxEvents(pool);
    const expired = await scheduling.expireHolds(); // RF-051: idempotent and cheap (partial index), safe from many workers
    if (expired) console.log(`[worker] expired ${expired} stale holds`);
    const a = await runAgentJobs({ pool, llm });
    const o = await dispatchOutbox(pool, sender);
    if (i.done || i.retried || i.dead || a.done || a.retried || a.failed || o.sent || o.failed || o.suppressed) console.log('[worker]', JSON.stringify({ inbox: i, agent: a, outbox: o }));
  } catch (e) {
    console.error('[worker] tick failed:', (e as Error).name);
  } finally { busy = false; }
}

const timer = setInterval(() => void tick(), every);
const stop = async () => { running = false; clearInterval(timer); while (busy) await new Promise((r) => setTimeout(r, 50)); await pool.end(); process.exit(0); };
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
console.log(`[worker] started (provider=${provider}, every ${every} ms, running=${running})`);
