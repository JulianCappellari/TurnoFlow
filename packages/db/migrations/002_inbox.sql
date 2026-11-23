-- TurnoFlow 002: inbox / human handoff (RF-017, RF-020..022, UC-04).
-- Identity is not built yet, so assignment is stored as an actor reference ("user:<id>") instead of a users FK.

ALTER TABLE conversations DROP COLUMN assigned_user_id;
ALTER TABLE conversations
  ADD COLUMN assigned_to       text,
  ADD COLUMN escalation_reason text,
  ADD COLUMN last_activity_at  timestamptz NOT NULL DEFAULT now();

-- Invariant: a human is assigned if and only if the conversation is being handled by a human.
ALTER TABLE conversations ADD CONSTRAINT conversations_assignment_ck
  CHECK ((mode = 'HUMAN_ACTIVE') = (assigned_to IS NOT NULL));

CREATE UNIQUE INDEX conversations_external_uq ON conversations (tenant_id, channel, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX conversations_inbox ON conversations (tenant_id, last_activity_at DESC);

-- The conversation version a message was produced under. A bot message can only exist for the version that was
-- current when it was written, so a stale job can never emit after a takeover (spec 13.4, TC-030).
ALTER TABLE messages ADD COLUMN conversation_version int NOT NULL DEFAULT 1;
-- Real insertion time, so ordering inside one transaction is stable.
ALTER TABLE messages ALTER COLUMN created_at SET DEFAULT clock_timestamp();
