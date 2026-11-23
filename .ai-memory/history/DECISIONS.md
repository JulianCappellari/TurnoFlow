# Decisions (append-only ADRs)

## D-20261123-01 Scope filter: P0 only (user directive)
P1/P2 (payments, coverage matrix, Google Calendar, audio, advanced waitlist) are not implemented and have no tables, except where P0 text references them.

## D-20261123-02 Concurrency: advisory lock per professional + exclusion constraints
`pg_advisory_xact_lock(hash(tenant, professional))` serializes hold/confirm/cancel per agenda; `EXCLUDE USING gist` on `appointments` (blocking statuses) and on ACTIVE `booking_holds` is the backstop (spec 11.2 warns SELECT FOR UPDATE alone is insufficient). Holds stay in their own table (spec 11.1). Verified by TC-020 and a raw-INSERT race test. Full note: docs/adr/0001-scheduling-concurrency.md.

## D-20261123-03 [PROPOSED, needs owner confirmation] Modeling assumptions not fixed by the spec
- Practice must fit inside the working window; the trailing buffer may extend past it. Occupancy = duration + buffer (RN-003).
- Clinic defaults (RN-008, all configurable columns): hold TTL 10 min (spec proposal), slot step 15 min, booking min notice 0, cancellation notice 0 (patients can cancel until start), booking horizon 90 days. Staff/system actors ignore the cancellation window.
- Blocking appointment statuses: CONFIRMED, IN_PROGRESS, NEEDS_REVIEW, SYNC_CONFLICT.
- `schedules` uses integer local minutes instead of `time` columns (enables overlap exclusion).
- Creating an availability block releases overlapping active holds but never touches appointments; they are returned to the operator (RF-032).

## D-20261123-04 Idempotency
`idempotency_keys(tenant_id, key)` claimed inside the business transaction; same key + same canonical payload replays stored response, different payload -> 409 IDEMPOTENCY_MISMATCH plus an audit row written outside the rolled-back tx (TC-022).

## D-20261123-06 HTTP layer
Fastify + zod (spec leaves NestJS/Fastify open). Strict schemas; errors as RFC7807 problem+json with correlationId; internals never leaked on 500. Confirm body uses `patientId` (spec example shows `patientContactId`; contacts not wired yet). Session token is interim HS256 (`AUTH_SECRET` >= 32 chars) until an identity provider is chosen. Raw-INSERT race can fail with 40P01 as well as 23P01; both mean rejected.

## D-20261123-07 Web app
Vite + React SPA (spec allows Vite instead of Next.js); no CSS/UI framework or external fonts (privacy, bundle 52 KB gz). Session token kept in sessionStorage (dev interim; replace with HttpOnly cookie flow when identity exists). Agenda shows patient name and phone to roles with `appointment.read` only. Patient phone must be entered with country code (no guessed prefix). `tsx` is used for dev scripts because Node strip-types cannot run parameter properties.

## D-20261123-05 Tenant trust boundary
SchedulingService receives `tenantId` in `Ctx` and scopes every query by it; the future API must derive it from the verified session, never from the body (spec sec. 12). Cross-tenant ids return NOT_FOUND (TC-100). RLS not enabled yet.

## D-20261123-08 Inbox concurrency and assignment
The conversation row (`SELECT ... FOR UPDATE`) serializes takeover, release, close, human replies and bot writes. Bot writes carry the `version` they read and are refused unless mode is BOT and the version still matches, so a stale job cannot answer after a takeover/release cycle (spec 13.4). Assignment is stored as text `user:<id>` (no users FK until identity exists); a DB check enforces HUMAN_ACTIVE iff assigned. A new inbound message reopens a CLOSED conversation for the bot. Owner/admin_clinic may release or close conversations held by someone else. Replies are stored PENDING and queued via outbox; nothing is sent to WhatsApp yet.

## D-20261123-09 Webhook and workers
The webhook only verifies the HMAC over the raw bytes, persists events and ACKs; everything else is a worker concern (RNF-007). The tenant is resolved exclusively from `channel_accounts` (provider phone number id); payload fields never choose a tenant. Provider payload shapes follow the WhatsApp Cloud API as understood by the team and are [VALIDAR] against current official docs before any real traffic (D-05); no real provider client exists. Queues (inbox_events, outbox_events) use claim-with-visibility-timeout + SKIP LOCKED, exponential backoff, DEAD parking; workers default to the database clock. Delivery is at-least-once, the message id is passed as idempotency key; a message already accepted by the provider cannot be withdrawn. Bot messages are re-checked against conversation mode/version right before sending and marked SUPPRESSED if superseded. Unsupported inbound types (audio, images; P1) are stored as a placeholder and escalated to a person. Known gaps: no rate limiting on the webhook, no retention job for inbox_events payloads, webhook latency only smoke-tested.

## D-20261123-10 AI agent
Full rationale in docs/adr/0002-ai-agent.md. Key points: the model proposes and the backend decides; strict allowlisted tools; slots are opaque references shown to the patient; confirmation needs an explicit yes in a later message; transactional facts are composed by code; urgency/human-request/NO are deterministic and never reach the model; cancel and reschedule are never done by the assistant until D-06; unregistered numbers and topics without an approved source escalate; per-clinic feature flag OFF by default; no real model until D-05/D-13/legal. Prompt version is recorded on every run (agent-2026-11-23.1). Known gaps: single-turn mock cannot judge real NLU quality; if a person takes over after a confirm executed but before the reply is written, the run is marked DISCARDED_AFTER_ACTION and the patient is not told (visible in agenda/audit); no per-tenant token/cost ledger for real providers yet.
