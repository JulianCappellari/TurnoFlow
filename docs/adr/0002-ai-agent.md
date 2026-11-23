# ADR 0002 — AI agent: the model proposes, the backend decides

Status: accepted for P0 (2026-11-23). Related: spec section 13, RN-006, RN-007, RN-013, RN-022, RN-023, TC-011, TC-030, TC-102.

## Context
The assistant answers patients on WhatsApp. A language model can misread, invent, or be talked into things by a patient's text.
No real model is connected yet: D-05, D-13 and the legal review (processors, data location, retention) are open, and the spec forbids
sending identifiable or health data to a provider before that.

## Decision
1. **Gateway interface** (`LlmGateway`): one turn in, either text or one tool call out. Only a rule-based stand-in (`RuleBasedMockLlm`)
   exists; the worker refuses any other `AGENT_LLM` value.
2. **Allowlisted tools with strict schemas** (`searchAvailability`, `createHold`, `confirmAppointment`, `cancelAppointment`,
   `handoffToHuman`, `getApprovedPolicy`). Unknown tools and unknown arguments are rejected. The model never reaches SQL or the services directly.
3. **Facts are written by code.** Offers, hold and confirmation messages are composed by the orchestrator from tool results; the model's own
   words are used only for non-transactional replies, and only after output checks (no booking claims without a successful confirmation,
   no links, length cap).
4. **Slots are opaque references** created by `searchAvailability` and stored server-side. `createHold` accepts only a reference shown to this
   patient in the last 30 minutes, so a time cannot be invented (TC-011).
5. **Explicit consent**: `confirmAppointment` succeeds only if the patient's latest message is an unambiguous yes and arrived after the message
   that created the hold. The model cannot supply it. A "no" releases the hold without calling the model.
6. **Guards before the model**: urgency text and escalation (RN-023), request for a person (RN-022), hourly cap on automatic replies (RN-028).
7. **Takeover wins**: the reply is written with the conversation version read at the start of the run; a person taking over discards the draft (TC-030).
8. **Reliable execution**: jobs come from the transactional outbox (`agent.inbound`), one `agent_runs` row per inbound message makes a run idempotent,
   a per-conversation advisory lock prevents two replies at once, bursts are coalesced to the newest message, and any failure ends in an apology
   plus a human hand-off.
9. **Privacy**: phone numbers and e-mails are masked, patient text is delimited as untrusted, and no patient identifier, appointment id or token is
   sent. The hold token lives only in `conversations.agent_state`.
10. **Feature flag**: `clinics.agent_enabled`, off by default.

## Blocked on purpose
- **Cancellation and rescheduling** by the assistant: D-06 (identity rule) is open, so it always escalates.
- **Booking for unregistered numbers**: needs consent and identification decisions (D-04, D-06); it escalates.
- **Coverage, prices, address, cancellation policy**: no approved, versioned source exists (RN-006, RF-025); it escalates.

## Consequences
- Safety does not depend on model quality; model quality only affects convenience.
- The 200-conversation evaluation (RNF-019) and red-team runs against a real model remain to be done before any pilot.
- A real gateway implementation must keep the same contract and be reviewed against D-13 first.
