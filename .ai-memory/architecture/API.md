# API (VERIFIED in apps/api/src/app.ts and whatsapp.ts)

Base `/api/v1`. Errors are RFC 7807 `application/problem+json` with `title` = error code and `correlationId`. `X-Correlation-ID` is accepted/echoed. Bodies/queries use strict zod schemas (unknown fields -> 422, so a `tenantId` in a body is always refused). Tenant and actor come ONLY from the verified session.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | /healthz | none | |
| GET | /availability?clinicId&serviceId&from&to[&professionalId] | schedule.read | max 31 days, UTC |
| POST | /booking-holds | appointment.create | 201 {holdId, confirmationToken, expiresAt...}; 409 SLOT_TAKEN, 422 SLOT_NOT_OFFERED |
| POST | /appointments/confirm | appointment.create | header `Idempotency-Key` required; body {holdId, patientId, confirmationToken}; 201, replay adds `Idempotent-Replayed: true`; 410 HOLD_EXPIRED; 409 mismatch |
| POST | /appointments/:id/cancel | appointment.cancel | repeat is idempotent |
| GET | /clinics, /catalog?clinicId | schedule.read | |
| GET | /agenda?clinicId&from&to | appointment.read | max 8 days; contains patient name/phone |
| GET, POST | /patients?q= , /patients | patient.read / patient.write | phone must be E.164-able, 409 on duplicate |
| GET | /inbox/conversations[?mode&before&limit] | inbox.read | |
| GET | /inbox/conversations/:id/messages | inbox.read | |
| POST | /inbox/conversations/:id/takeover, /release, /close | inbox.takeover | owner/admin may override another person's lock |
| POST | /inbox/conversations/:id/messages | inbox.takeover | only the assignee; queued via outbox |
| GET, POST | /webhooks/whatsapp | public, signed | only registered when WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN are set; HMAC-SHA256 over raw body, 256 KB cap |

Auth today: INTERIM HS256 bearer token (`signSessionToken` in `apps/api/src/auth.ts`, secret `AUTH_SECRET` >= 32 chars). Replace with a managed identity provider (RF-003/005) keeping the `Session {userId, tenantId, role}` shape.

Not implemented: OpenAPI document, rate limiting, CORS config, security headers, reschedule, privacy/export endpoints, metrics endpoint, CRUD for clinics/professionals/services/schedules/exceptions (the service method `createScheduleException` exists, no route).
