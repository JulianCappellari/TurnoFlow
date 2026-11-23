# System (VERIFIED against code on 2026-11-23)

Monolithic modular TypeScript monorepo (npm workspaces, ESM, `.ts` imports, run with `tsx`). PostgreSQL 16 is the only datastore. No Redis: queues are tables.

```
WhatsApp (SIMULATED) --signed POST--> apps/api  (Fastify 5)
                                         | writes inbox_events (durable) and answers 200
Browser (apps/web, Vite+React) --/api--> apps/api --> packages/db services --> PostgreSQL
                                                          ^
apps/worker (loops every 1 s) ----------------------------+
   1 processInboxEvents  inbox_events -> conversations/messages (+ outbox agent.inbound)
   2 expireHolds         stale booking holds -> EXPIRED
   3 runAgentJobs        outbox agent.inbound -> packages/ai-policy -> bot reply (outbox message.send_requested)
   4 dispatchOutbox      outbox message.send_requested -> WhatsAppSender (MOCK only)
```

| Path | Role |
|---|---|
| `packages/domain` | Pure logic: slot generation (luxon, DST-safe), appointment/hold/conversation state machines, `DomainError` codes -> HTTP status |
| `packages/db` | Migrations 001-004, `SchedulingService`, `InboxService`, `DirectoryService`, messaging ingest/outbound, agent store. ALL SQL lives here |
| `packages/ai-policy` | Agent: guards, strict tools, orchestrator, job runner, rule-based MOCK model |
| `apps/api` | HTTP layer: auth (interim HS256), RBAC, zod validation, problem+json, webhook, dev scripts |
| `apps/web` | Reception panel: login by token, Agenda, Bandeja (inbox) |
| `apps/worker` | Background loops above |

Dependency rule (spec 10.3): agent -> application services -> domain -> SQL. The agent never writes tables directly.

Key invariants live in: `docs/adr/0001-scheduling-concurrency.md`, `docs/adr/0002-ai-agent.md`, `.ai-memory/history/DECISIONS.md`.
Nothing talks to a real WhatsApp, a real LLM or any external service. Everything external is a mock behind an interface.
