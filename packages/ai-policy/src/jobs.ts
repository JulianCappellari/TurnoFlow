import { InboxService, claimAgentJobs, completeAgentJob, retryAgentJob } from '@turnoflow/db';
import { handleInbound, type AgentDeps } from './orchestrator.ts';

export interface AgentJobOptions { limit?: number; now?: Date; tenantId?: string; maxAttempts?: number }

/**
 * Worker step: consumes `agent.inbound` events from the transactional outbox. A message is only retried when the run could not
 * start (conversation busy, database trouble); once a run started, `agent_runs` guarantees it answers at most once.
 */
export async function runAgentJobs(deps: AgentDeps, opts: AgentJobOptions = {}): Promise<{ done: number; retried: number; failed: number }> {
  const max = opts.maxAttempts ?? 4;
  const out = { done: 0, retried: 0, failed: 0 };
  const jobs = await claimAgentJobs(deps.pool, opts);
  for (const job of jobs) {
    const conversationId = job.payload_min.conversationId;
    if (!conversationId) { await completeAgentJob(deps.pool, job.id, 'BAD_PAYLOAD'); out.failed += 1; continue; }
    try {
      const outcome = await handleInbound(deps, { tenantId: job.tenant_id, conversationId, inboundMessageId: job.aggregate_id });
      if (outcome === 'LOCKED') {
        if (job.attempts >= max) { await completeAgentJob(deps.pool, job.id, 'LOCKED_GIVEUP'); out.failed += 1; } else { await retryAgentJob(deps.pool, job.id, 'LOCKED', 5, opts.now); out.retried += 1; }
        continue;
      }
      await completeAgentJob(deps.pool, job.id);
      out.done += 1;
    } catch (e) {
      const name = (e as Error).name ?? 'ERROR';
      if (job.attempts >= max) {
        // Last resort: make sure a person sees the conversation instead of dropping it silently (RNF-020).
        await new InboxService(deps.pool).requestHuman({ tenantId: job.tenant_id, actor: { type: 'system', id: 'agent-jobs' } }, { conversationId, reason: 'El asistente no pudo procesar el mensaje' }).catch(() => undefined);
        await completeAgentJob(deps.pool, job.id, name);
        out.failed += 1;
      } else { await retryAgentJob(deps.pool, job.id, name, 5 * 2 ** job.attempts, opts.now); out.retried += 1; }
    }
  }
  return out;
}
