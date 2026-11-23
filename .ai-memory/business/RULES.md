# Business rules: what is IMPLEMENTED (verified by tests) vs PROPOSED

Spec ids refer to `docs/product/ESPECIFICACION_INTEGRAL_2026.md`.

| Rule | Status | Where / test |
|---|---|---|
| RN-001 tenant isolation | IMPLEMENTED | TC-100 tests |
| RN-003 duration + buffer occupancy | IMPLEMENTED (buffer may extend past working window: PROPOSED assumption) | domain slots tests |
| RN-004 service enabled for professional | IMPLEMENTED | service tests |
| RN-005 no slots outside hours / holidays / blocks / bookings | IMPLEMENTED | TC-011 |
| RN-007 phone does not authorize | IMPLEMENTED for booking/cancel by patient actor; agent never cancels | agent tests |
| RN-009 absolute times + clinic timezone | IMPLEMENTED (DST tested for New York) | slots + web time tests |
| RN-010 no overlapping bookings | IMPLEMENTED, DB-enforced | TC-020 + 10,000-attempt stress |
| RN-011 hold TTL (10 min default, configurable per clinic) | IMPLEMENTED | service tests |
| RN-012 idempotent confirm | IMPLEMENTED | TC-021/022 |
| RN-013 no confirmation by text | IMPLEMENTED in agent output policy | agent tests |
| RN-014 cancelled stays cancelled | IMPLEMENTED (state machine, no resurrection) | tests |
| RN-017 degraded mode | PARTIAL: agent falls back to a person; no panel kill-switch | |
| RN-021 consent/opt-out | NOT IMPLEMENTED (needs D-04) | |
| RN-022 human request disables agent | IMPLEMENTED | TC-030 family |
| RN-023 urgency -> fixed text + human | IMPLEMENTED | guards tests |
| RN-024 no clinical data | by design: agent refuses clinical advice; nothing stores clinical fields | |
| RN-027 sensitive changes audited | PARTIAL: booking/cancel/handoff/takeover audited; admin changes N/A yet | |
| RN-028 usage limit = controlled degradation | PARTIAL: hourly cap on bot replies | |
| RN-002, RN-006, RN-008 (rule publishing/versioning, coverage) | NOT IMPLEMENTED (P1 or admin phase) | |

Explicit defaults chosen without the owner (RN-008 says defaults must be explicit): hold TTL 10 min, slot step 15 min, booking notice 0, cancellation notice 0, horizon 90 days. See `history/DECISIONS.md` D-20261123-03.
