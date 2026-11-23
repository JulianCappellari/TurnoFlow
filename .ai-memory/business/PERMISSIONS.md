# Permissions (VERIFIED in apps/api/src/auth.ts; deny by default, enforced server-side)

| Permission | owner | admin_clinic | receptionist | practitioner | support_limited |
|---|---|---|---|---|---|
| schedule.read | yes | yes | yes | yes | no |
| appointment.read (agenda with patient data) | yes | yes | yes | no | no |
| appointment.create | yes | yes | yes | no | no |
| appointment.cancel | yes | yes | yes | no | no |
| patient.read / patient.write | yes | yes | yes | no | no |
| inbox.read / inbox.takeover | yes | yes | yes | no | no |
| override another person's conversation (release/close) | yes | yes | no | no | no |

Gaps vs spec: no `clinic.write`/`admin` permissions yet (no admin endpoints exist), no `privacy.request`, `analytics.read`, `payments.*` (P1). `practitioner` should eventually see only their own agenda (RF/US) - not implemented. `support_limited` must get just-in-time, audited access (US-003) - not implemented.

Tenant isolation is enforced twice: every query filters by `tenant_id` and composite FKs forbid cross-tenant links. Foreign ids return 404, never 403 (no existence leak). Tests: TC-100 in `packages/db/test/schema.test.ts` and `apps/api/test/api.test.ts`.
