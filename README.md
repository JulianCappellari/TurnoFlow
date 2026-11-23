# TurnoFlow

Administrative scheduling automation for dental clinics (spec: `TurnoFlow_Especificacion_Integral_2026.md`).
Current scope: **P0 only**. Build order follows spec 24.1: database + scheduling engine first, AI/WhatsApp last.

## Layout

| Path | Purpose |
|---|---|
| `packages/domain` | Pure TypeScript: slot generation (timezone/DST safe), appointment and hold state machines, error codes |
| `packages/db` | PostgreSQL migrations, migrator, `SchedulingService` (availability, holds, confirm, cancel, blocks) |
| `apps/api` | Fastify HTTP API: availability, holds, confirm, cancel (problem+json, RBAC, idempotency) |
| `apps/web` | Vite + React reception panel (agenda, new appointment, cancel) |
| inbox | `InboxService` (conversations, human takeover, guarded bot replies) in `packages/db`; `Bandeja` tab in the panel |
| `apps/worker` | Background loops: apply webhook events, deliver queued messages (mock provider only) |
| `packages/ai-policy` | AI agent: guards, allowlisted tools, orchestrator, job runner, rule-based mock model (no real model connected) |
| `docs/adr` | Architecture decisions |
| `.ai-memory` | Shared project memory for Claude Code / Codex |

## Run

```powershell
npm install
npm run db:up        # PostgreSQL 16 in Docker on port 54329 (synthetic data only)
npm test             # unit + integration + concurrency (TC-020, TC-021, TC-022, TC-040, TC-100)
npm run test:stress  # 10,000 concurrent attempts (RNF-004), about 50 s
npm run typecheck
```

## Guarantees implemented so far

- No two active appointments overlap for a professional: advisory lock per agenda plus `EXCLUDE USING gist` backstop.
- Holds expire; confirmation requires a valid one-time token and an `Idempotency-Key`.
- Every query is tenant-scoped, and composite foreign keys block cross-tenant references.
- `audit_events` is append-only at database level; business events go through a transactional outbox.
- Slots are computed only by the backend from rules, blocks and existing bookings; nothing is inferred by text.

API: `DATABASE_URL=... AUTH_SECRET=<32+ chars> tsx apps/api/src/server.ts` (tokens are interim HS256; tenant and role come only from the token).

Panel (development): `npm run dev:db`, then in separate terminals `npm run dev:api` (env `DATABASE_URL`, `AUTH_SECRET`) and `npm run dev:web`; get a login token with `npm run dev:seed` (creates a synthetic demo tenant).

AI agent (development): the demo clinic has it enabled (`clinics.agent_enabled` is OFF by default); the worker runs a rule-based stand-in model, not a real one. Try `npm run dev:wa -- "Quiero un turno para una consulta" 5491155550101`.

WhatsApp webhook (development, simulated provider): set `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` (16+ chars) for the API, run `npm run dev:worker`, then `npm run dev:wa -- "texto" 5491166660001` to send a signed message. No real WhatsApp client exists yet.

Not implemented yet: identity provider/MFA, real language model, real WhatsApp client, WhatsApp webhook, AI orchestration, CI.
