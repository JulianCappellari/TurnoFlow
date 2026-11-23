# ADR 0001 — Scheduling concurrency model

Status: accepted for P0 (2026-11-23). Related: RN-010, RN-012, RNF-004, spec 11.2, TC-020/021.

## Context
Two requests for the same slot must never both confirm. `SELECT ... FOR UPDATE` cannot lock a row that does not exist yet, so it is not enough on its own (spec 11.2).

## Decision
1. Every write that changes a professional's agenda (create/release hold, confirm, cancel, add block) first takes `pg_advisory_xact_lock(hashtextextended('agenda:<tenant>:<professional>', 0))`. Writers of one agenda are serialized; different professionals run in parallel. The lock is released at commit or rollback.
2. After the lock, availability is recomputed from committed data (rules, blocks, appointments, active holds) by the same pure function used for search.
3. `EXCLUDE USING gist` on `appointments` (blocking statuses) and on `booking_holds` (ACTIVE) over `tstzrange(start_at, occupied_until)` is the last line of defence. A violation (`23P01`) is mapped to `SLOT_TAKEN` (409).
4. Confirm consumes the hold and creates the appointment in one transaction, together with audit row, outbox event and idempotency response.

## Consequences
- Throughput per professional is bounded by transaction time (a few ms); acceptable for clinic agendas.
- Multiple API instances are safe because locks and constraints live in PostgreSQL.
- External calendars (P1) are not protected by these constraints; conflicts there must be handled by reconciliation (RN-016).
- Verified: TC-020 variants (100 patients, 100 holds, 100 confirms with different keys, 100 with one key), a raw-INSERT race, overlapping starts, and 10,000 attempts over 100 slots (0 duplicates).
