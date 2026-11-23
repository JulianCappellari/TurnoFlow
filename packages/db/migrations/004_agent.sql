-- TurnoFlow 004: AI agent support (spec section 13).
-- The agent is OFF by default per clinic (feature flag, spec 18.2) and keeps its conversational memory server-side.

ALTER TABLE clinics ADD COLUMN agent_enabled boolean NOT NULL DEFAULT false;

-- Offers shown to the patient, a pending hold and its secret token. Never sent to the language model.
ALTER TABLE conversations ADD COLUMN agent_state jsonb NOT NULL DEFAULT '{}';

ALTER TABLE messages ADD CONSTRAINT messages_tenant_id_uq UNIQUE (tenant_id, id);

-- One row per inbound message the agent considered: idempotency (a job can run twice, the reply cannot), observability and cost.
CREATE TABLE agent_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  conversation_id    uuid NOT NULL,
  inbound_message_id uuid NOT NULL,
  status             text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'DONE', 'SKIPPED', 'FAILED')),
  outcome            text,
  llm_calls          int NOT NULL DEFAULT 0,
  tool_calls         int NOT NULL DEFAULT 0,
  prompt_version     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  UNIQUE (tenant_id, inbound_message_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, inbound_message_id) REFERENCES messages (tenant_id, id)
);
CREATE INDEX agent_runs_conversation ON agent_runs (tenant_id, conversation_id, created_at DESC);
