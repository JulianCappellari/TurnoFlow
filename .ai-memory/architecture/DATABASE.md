# Database (VERIFIED: migrations 001-004 applied and tested on PostgreSQL 16)

Rules: `tenant_id` on every business table; composite FKs `(tenant_id, id)` so cross-tenant references are impossible; UTC `timestamptz`; integer minutes; uuid ids (`gen_random_uuid()`); no clinical data. Migrations are plain SQL in `packages/db/migrations`, applied in filename order, checksummed (never edit an applied file: add a new one).

| Migration | Adds |
|---|---|
| 001_init | tenants, users, memberships, clinics (+policy columns), professionals, services, professional_services, schedules (weekly rules in local minutes, overlap-exclusion), schedule_exceptions, patients, patient_contacts, appointments, booking_holds, idempotency_keys, conversations, messages, inbox_events, outbox_events, audit_events (append-only triggers), consent_records, privacy_requests, usage_ledger |
| 002_inbox | conversations.assigned_to / escalation_reason / last_activity_at, CHECK (HUMAN_ACTIVE iff assigned_to), messages.conversation_version, unique conversation per (tenant, channel, external_ref) |
| 003_messaging | channel_accounts (provider phone number -> tenant/clinic), inbox_events as queue (status, attempts, next_attempt_at, last_error), outbox last_error, delivery_status += SUPPRESSED |
| 004_agent | clinics.agent_enabled (default false), conversations.agent_state, agent_runs (unique per inbound message) |

Concurrency guarantees (do not weaken):
- `appointments_no_overlap` and `booking_holds_no_overlap` are GiST exclusion constraints on `tstzrange(start_at, occupied_until)` per professional (blocking statuses only).
- Every agenda write first takes `pg_advisory_xact_lock(hashtextextended('agenda:<tenant>:<professional>', 0))`.
- Conversation changes take `SELECT ... FOR UPDATE` on the conversation row.
- Queues (inbox_events, outbox_events) are claimed with `FOR UPDATE SKIP LOCKED` plus a 60 s visibility timeout, exponential backoff, DEAD parking. Workers use the DATABASE clock unless a test passes `now`.

Not created yet (P1/P2): coverage_rules, waitlist_entries, payment_orders, integration_accounts, sync_cursors, resources, appointment_resources. Missing P0 pieces: invitations table, session/MFA tables (identity provider undecided), retention jobs.

Test DB: `turnoflow_test` is dropped and recreated by `packages/db/test/global-setup.ts` on every `npm test` (refuses names without "test").
