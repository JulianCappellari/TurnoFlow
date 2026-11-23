# Project Context — TurnoFlow
- Memory schema: 2.0
- Updated: 2026-11-23
- Last agent: Claude Code (Sonnet 5.5)
- Branch/HEAD: git repo on branch main; remote origin = https://github.com/JulianCappellari/TurnoFlow.git (first commit made locally, push pending user confirmation)
- Evidence freshness: VERIFIED by test run on 2026-11-23 (see ACTIVE_TASK / handoff)

## Purpose and scope
SaaS B2B multi-tenant for Argentine dental clinics: WhatsApp-driven administrative scheduling with human handoff. Source spec: `C:\Users\Cappellari\Downloads\TurnoFlow_Especificacion_Integral_2026.md` (DOCUMENTED, status "proposed, not approved"). **User directive: implement only `P0`** (ignore P1/P2: payments, coverage matrix, Google Calendar, audio, advanced waitlist). Order: domain+db core -> concurrency tests -> HTTP availability API + basic reception panel -> only then WhatsApp webhook + LLM orchestrator calling the same functions (spec 24.1).

## Current implementation status
See [PROJECT_STATE.md](PROJECT_STATE.md). Done: monorepo, P0 schema (migration 001), pure scheduling domain, transactional SchedulingService, TC-020/021/022/040/100 + RNF-004 stress passing on real PostgreSQL.

## Confirmed stack, versions, commands (VERIFIED)
Node 24, npm workspaces, TypeScript (ESM, `.ts` imports), vitest 2, `pg`, `luxon`. PostgreSQL 16 via `docker compose` on port 54329.
- `npm run db:up` / `db:down`, `npm test`, `npm run typecheck`, `npm run test:stress` (10,000 attempts, ~48 s).
- Tests recreate DB `turnoflow_test` in vitest globalSetup (refuses names without "test").

## Architecture and navigation
- `packages/domain`: pure TS (slot generation, state machines, DomainError codes -> HTTP status).
- `packages/db`: `migrations/001_init.sql`, `src/migrate.ts`, `src/scheduling/service.ts` (SchedulingService), `src/tx.ts`.
- Concurrency model: per-professional `pg_advisory_xact_lock` + `EXCLUDE USING gist` on appointments and active holds (backstop). Composite (tenant_id, id) FKs for isolation.
- Not yet created: apps/api, apps/web, apps/worker, packages/contracts, auth/RBAC, WhatsApp, agent.

## Critical invariants
See [business/RULES.md](business/RULES.md). Decisions: [history/DECISIONS.md](history/DECISIONS.md).

## Active work / next
See [ACTIVE_TASK.md](ACTIVE_TASK.md), [handoffs/LATEST_HANDOFF.md](handoffs/LATEST_HANDOFF.md).

## Unknowns, risks
D-01..D-14 open (spec sec. 23). No auth/RBAC yet: service trusts `Ctx.tenantId` (API layer must derive it from session). Folder lives in OneDrive (node_modules sync risk).
