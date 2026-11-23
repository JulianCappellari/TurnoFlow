# Workflows (VERIFIED end to end with real processes on 2026-11-23)

1. **Booking by reception (UC-02 via panel)**: availability -> `createHold` (token, TTL) -> `confirmAppointment` (Idempotency-Key). One transaction, audit row and outbox event `appointment.confirmed`.
2. **Booking by the agent**: patient message -> signed webhook -> `inbox_events` -> worker -> `recordInbound` (+ outbox `agent.inbound` if clinic.agent_enabled and mode=BOT) -> `handleInbound`: guards -> mock model proposes tools -> offers (opaque refs) -> hold -> patient says yes in a LATER message -> confirm -> reply composed by code -> `recordBotMessage(expectedVersion)` -> outbox `message.send_requested` -> dispatcher -> provider.
3. **Handoff (UC-04)**: bot/policy `requestHuman` (HUMAN_PENDING + reason) or person `takeover` (HUMAN_ACTIVE, assigned). From then on any bot write fails (version/mode check) and queued bot messages are SUPPRESSED at delivery. `release` returns to BOT under a new version.
4. **Urgency (UC-10)**: deterministic regex on the inbound text -> fixed message -> HUMAN_PENDING. The model is not called.
5. **Cancel (UC-05)**: staff via API/panel only. The agent always escalates (D-06 open).
6. **Delivery receipts**: status events move `delivery_status` forward only; unknown message ids are retried then parked DEAD.

Not implemented: reschedule (P1), waitlist (P1), reminders (P1), payments (P1), calendar sync (P1), privacy export/erasure (RF-049/050), onboarding/clinic configuration flow (UC-01).
