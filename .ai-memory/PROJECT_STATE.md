# Project State (2026-11-23)

| Area | Status | Evidence |
|---|---|---|
| Monorepo + tooling | DONE, VERIFIED | `npm run typecheck` clean |
| P0 DB schema (migration 001) | DONE, VERIFIED | migrates on PG16; constraint tests |
| Scheduling domain (slots, states) | DONE, VERIFIED | 12 unit tests incl. DST |
| SchedulingService | DONE, VERIFIED | 22 service tests + 7 concurrency tests |
| TC-020 / TC-021 / TC-022 / TC-040 / TC-100 | PASS | packages/db/test |
| RNF-004 (10,000 concurrent attempts) | PASS once, 2026-11-23 | `npm run test:stress` |
| RBAC (deny by default) + interim HS256 token | DONE, VERIFIED (interim) | apps/api/test |
| Identity provider, MFA, invitations | NOT STARTED | RF-003/005 |
| apps/api (HTTP: availability, hold, confirm, cancel) | DONE, VERIFIED | 10 HTTP tests |
| Reception panel (apps/web): agenda, book, cancel | DONE, manually verified in browser | no automated UI tests |
| Inbox / takeover (RF-020/022, TC-030) | DONE, VERIFIED (DB + API tests, manual UI) | packages/db/test/inbox.test.ts |
| Signed WhatsApp webhook + ingest worker + outbound dispatcher (mock provider) | DONE, VERIFIED | packages/db/test/messaging.test.ts, apps/api/test/whatsapp.test.ts, live run |
| Real WhatsApp client | NOT STARTED (blocked on D-05/D-13/legal + authorization) | — |
| Agent orchestration (mock model): tools, policy, guards, jobs | DONE, VERIFIED | packages/ai-policy/test (97 tests), live run |
| Real LLM gateway client | NOT STARTED (blocked: D-05, D-13, legal, authorization) | - |
| LLM evaluation set (RNF-019, 200 conversations) | NOT STARTED (synthetic safety cases only: ~60 phrases) | needs a real model |
| Appointment outbox events (confirmed/cancelled) | accumulate undispatched | no consumer until reminders (P1) or sync |
| Directory API (clinics, catalog, agenda, patients) | DONE, VERIFIED | 3 HTTP tests |
| WhatsApp webhook, agent | NOT STARTED (deliberately last) | — |
| CI/CD | NOT STARTED | — |
