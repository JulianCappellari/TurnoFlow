# Backend (VERIFIED)

- **Services take a `Ctx`** `{tenantId, actor:{type: user|patient|agent|system, id}, correlationId?, now?}`. The API builds it from the session; never from request data. `now` exists only for tests.
- **Errors**: services throw `DomainError(code)` from `packages/domain/src/errors.ts` (code -> HTTP status map). The API error handler turns them into problem+json; anything else becomes a generic 500 (nothing leaked).
- **Transactions**: `withTx` in `packages/db/src/tx.ts`. Do not run concurrent queries on one transaction client (pg deprecation). Long external calls (LLM) must NOT hold a transaction: the agent uses a session advisory lock on its own connection instead.
- **Idempotency**: `idempotency_keys` row claimed inside the business transaction (confirm); natural idempotency elsewhere (cancel, takeover, release, requestHuman).
- **Audit**: `audit()` helper in `scheduling/service.ts`. Metadata must contain identifiers only, never message bodies or personal data.
- **Outbox**: events inserted in the same transaction as the change. Types today: `appointment.confirmed`, `appointment.cancelled` (no consumer yet), `message.send_requested` (dispatcher), `agent.inbound` (agent jobs).
- **Time**: instants are UTC `Date`; local-time reasoning only inside `packages/domain/src/scheduling/slots.ts` (luxon) with the clinic IANA zone.
- **Scripts run with `tsx`**, not Node strip-types (parameter properties and enums are not supported by strip-types).
- **Pitfalls seen**: mixing JS and DB clocks in queue claims (use DB clock); parallel test files share one DB, so test workers/queues must be scoped with `tenantId`; the tests create a fresh tenant per test.
