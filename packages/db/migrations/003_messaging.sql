-- TurnoFlow 003: channel accounts, reliable webhook ingestion and outbound dispatch (RF-016, RF-017, spec 14.4).

-- Which tenant/clinic owns a provider phone number. Webhooks are routed ONLY through this table, never through payload claims.
CREATE TABLE channel_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  clinic_id         uuid NOT NULL,
  provider          text NOT NULL CHECK (provider IN ('whatsapp')),
  external_account_ref text NOT NULL,                  -- WhatsApp phone_number_id (not a secret)
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_account_ref),
  FOREIGN KEY (tenant_id, clinic_id) REFERENCES clinics (tenant_id, id)
);

-- Inbox events become a small durable queue: claimed with a visibility timeout, retried with backoff, then parked as DEAD.
ALTER TABLE inbox_events
  ADD COLUMN status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE', 'DEAD')),
  ADD COLUMN attempts        int  NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_error      text;
CREATE INDEX inbox_events_pending ON inbox_events (next_attempt_at) WHERE status = 'PENDING';

ALTER TABLE outbox_events ADD COLUMN last_error text;

-- A queued bot message whose conversation changed hands before delivery is never sent (spec 13.4).
ALTER TABLE messages DROP CONSTRAINT messages_delivery_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_delivery_status_check
  CHECK (delivery_status IN ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SUPPRESSED'));
