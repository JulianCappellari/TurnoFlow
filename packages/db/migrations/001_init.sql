-- TurnoFlow 001: P0 core schema (spec section 11).
-- Principles: tenant_id on every business table, composite FKs (tenant_id, id) so a row can never
-- reference another tenant's data (RN-001/RNF-002), UTC timestamptz, integer minutes, no clinical data.
-- Out of this migration on purpose (P1/P2): coverage_rules, waitlist_entries, payment_orders,
-- integration_accounts, sync_cursors, resources, appointment_resources.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- identity / tenancy
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED')),
  region      text NOT NULL DEFAULT 'UNSET',               -- D-13 unresolved
  timezone    text NOT NULL DEFAULT 'America/Argentina/Buenos_Aires'
              CHECK (timezone(timezone, TIMESTAMPTZ '2000-01-01 00:00:00+00') IS NOT NULL),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_auth_id text NOT NULL UNIQUE,
  email            text NOT NULL,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE memberships (
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  user_id    uuid NOT NULL REFERENCES users (id),
  role       text NOT NULL CHECK (role IN ('owner', 'admin_clinic', 'receptionist', 'practitioner', 'support_limited')),
  status     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

-- ---------------------------------------------------------------- organization
CREATE TABLE clinics (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants (id),
  name                   text NOT NULL,
  timezone               text NOT NULL
                         CHECK (timezone(timezone, TIMESTAMPTZ '2000-01-01 00:00:00+00') IS NOT NULL),
  status                 text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  -- RN-008: explicit, configurable defaults (never hidden assumptions). Values are PROPOSED, see DECISIONS.
  booking_min_notice_min int  NOT NULL DEFAULT 0   CHECK (booking_min_notice_min >= 0),
  cancellation_notice_min int NOT NULL DEFAULT 0   CHECK (cancellation_notice_min >= 0),
  hold_ttl_min           int  NOT NULL DEFAULT 10  CHECK (hold_ttl_min BETWEEN 1 AND 120),
  slot_step_min          int  NOT NULL DEFAULT 15  CHECK (slot_step_min IN (5, 10, 15, 20, 30, 60)),
  max_booking_horizon_days int NOT NULL DEFAULT 90 CHECK (max_booking_horizon_days BETWEEN 1 AND 365),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE professionals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  clinic_id  uuid NOT NULL,
  name       text NOT NULL,
  specialty  text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, clinic_id) REFERENCES clinics (tenant_id, id)
);

CREATE TABLE services (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  name         text NOT NULL,
  duration_min int NOT NULL CHECK (duration_min > 0),
  buffer_min   int NOT NULL DEFAULT 0 CHECK (buffer_min >= 0),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE professional_services (
  tenant_id       uuid NOT NULL,
  professional_id uuid NOT NULL,
  service_id      uuid NOT NULL,
  PRIMARY KEY (tenant_id, professional_id, service_id),
  FOREIGN KEY (tenant_id, professional_id) REFERENCES professionals (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES services (tenant_id, id)
);

-- Weekly hours in local minutes (deviation from start_local/end_local `time`: integer minutes allow a
-- range-type exclusion constraint that rejects overlapping rules, RF-002/RF-010).
CREATE TABLE schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  professional_id uuid NOT NULL,
  weekday         int NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute    int NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute      int NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CHECK (start_minute < end_minute),
  FOREIGN KEY (tenant_id, professional_id) REFERENCES professionals (tenant_id, id),
  EXCLUDE USING gist (
    tenant_id WITH =, professional_id WITH =, weekday WITH =,
    int4range(start_minute, end_minute) WITH &&
  )
);

-- Holidays (professional_id NULL = whole clinic), absences and manual blocks.
CREATE TABLE schedule_exceptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  clinic_id       uuid NOT NULL,
  professional_id uuid,
  kind            text NOT NULL CHECK (kind IN ('HOLIDAY', 'ABSENCE', 'BLOCK')),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  reason          text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  FOREIGN KEY (tenant_id, clinic_id) REFERENCES clinics (tenant_id, id),
  FOREIGN KEY (tenant_id, professional_id) REFERENCES professionals (tenant_id, id)  -- MATCH SIMPLE: NULL skips
);
CREATE INDEX schedule_exceptions_lookup ON schedule_exceptions (tenant_id, clinic_id, starts_at, ends_at);

-- ---------------------------------------------------------------- patients (minimal identification)
CREATE TABLE patients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  full_name      text NOT NULL,
  phone_e164     text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  privacy_status text NOT NULL DEFAULT 'PENDING' CHECK (privacy_status IN ('PENDING', 'ACCEPTED', 'REVOKED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, phone_e164)
);

CREATE TABLE patient_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  patient_id  uuid NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('WHATSAPP', 'PHONE', 'WEB')),
  external_id text NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel, external_id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients (tenant_id, id)
);

-- ---------------------------------------------------------------- scheduling core
CREATE TABLE appointments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  clinic_id           uuid NOT NULL,
  patient_id          uuid NOT NULL,
  professional_id     uuid NOT NULL,
  service_id          uuid NOT NULL,
  start_at            timestamptz NOT NULL,
  end_at              timestamptz NOT NULL,          -- end of the practice
  occupied_until      timestamptz NOT NULL,          -- end_at + buffer (RN-003); what the constraint protects
  status              text NOT NULL CHECK (status IN (
    'REQUESTED', 'HELD', 'PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED',
    'NO_SHOW', 'CANCELLED', 'EXPIRED', 'SYNC_CONFLICT', 'NEEDS_REVIEW')),
  version             int NOT NULL DEFAULT 1,
  cancelled_at        timestamptz,
  cancellation_reason text,
  cancelled_by        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (start_at < end_at AND end_at <= occupied_until),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, clinic_id) REFERENCES clinics (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients (tenant_id, id),
  FOREIGN KEY (tenant_id, professional_id) REFERENCES professionals (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES services (tenant_id, id),
  -- RN-010: last line of defence. The service layer also serializes per professional.
  CONSTRAINT appointments_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, professional_id WITH =,
    tstzrange(start_at, occupied_until, '[)') WITH &&
  ) WHERE (status IN ('CONFIRMED', 'IN_PROGRESS', 'NEEDS_REVIEW', 'SYNC_CONFLICT'))
);
CREATE INDEX appointments_agenda ON appointments (tenant_id, professional_id, start_at);
CREATE INDEX appointments_patient ON appointments (tenant_id, patient_id, start_at);

CREATE TABLE booking_holds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  clinic_id       uuid NOT NULL,
  professional_id uuid NOT NULL,
  service_id      uuid NOT NULL,
  start_at        timestamptz NOT NULL,
  end_at          timestamptz NOT NULL,
  occupied_until  timestamptz NOT NULL,
  slot_key        text NOT NULL,                     -- opaque: professional + start instant
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'RELEASED')),
  expires_at      timestamptz NOT NULL,
  token_hash      text NOT NULL,                     -- sha256 of the one-time confirmation token
  appointment_id  uuid,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (start_at < end_at AND end_at <= occupied_until),
  CHECK (expires_at > created_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, clinic_id) REFERENCES clinics (tenant_id, id),
  FOREIGN KEY (tenant_id, professional_id) REFERENCES professionals (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES services (tenant_id, id),
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments (tenant_id, id),
  CONSTRAINT booking_holds_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, professional_id WITH =,
    tstzrange(start_at, occupied_until, '[)') WITH &&
  ) WHERE (status = 'ACTIVE')
);
CREATE INDEX booking_holds_expiry ON booking_holds (expires_at) WHERE status = 'ACTIVE';

-- RN-012 / RNF idempotency: one row per (tenant, key); request_hash detects a reused key with other payload.
CREATE TABLE idempotency_keys (
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  key          text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash text NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- ---------------------------------------------------------------- messaging (storage only; no provider wiring yet)
CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  clinic_id        uuid NOT NULL,
  patient_id       uuid,
  channel          text NOT NULL CHECK (channel IN ('WHATSAPP', 'WEB')),
  external_ref     text,
  mode             text NOT NULL DEFAULT 'BOT' CHECK (mode IN ('BOT', 'HUMAN_PENDING', 'HUMAN_ACTIVE', 'CLOSED')),
  version          int NOT NULL DEFAULT 1,            -- bumps on takeover/release so stale bot jobs can be discarded (UC-04)
  assigned_user_id uuid REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, clinic_id) REFERENCES clinics (tenant_id, id),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients (tenant_id, id)
);

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  conversation_id     uuid NOT NULL,
  provider_message_id text,
  direction           text NOT NULL CHECK (direction IN ('IN', 'OUT')),
  sender_kind         text NOT NULL CHECK (sender_kind IN ('PATIENT', 'BOT', 'HUMAN', 'SYSTEM')),
  body                text NOT NULL,                  -- contains personal data: excluded from logs/analytics (RNF-011)
  delivery_status     text NOT NULL DEFAULT 'PENDING' CHECK (delivery_status IN ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
);
CREATE UNIQUE INDEX messages_provider_uq ON messages (tenant_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX messages_conversation ON messages (tenant_id, conversation_id, created_at);

CREATE TABLE inbox_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants (id),
  provider    text NOT NULL,
  event_id    text NOT NULL,
  payload     jsonb NOT NULL,                         -- short retention (spec 15.3)
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, event_id)
);

-- ---------------------------------------------------------------- outbox / audit / privacy / cost
CREATE TABLE outbox_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  type            text NOT NULL,
  payload_min     jsonb NOT NULL DEFAULT '{}',       -- identifiers only, no personal data
  created_at      timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz,
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox_events (next_attempt_at) WHERE dispatched_at IS NULL;

CREATE TABLE audit_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants (id),
  actor_type     text NOT NULL,
  actor_id       text,
  action         text NOT NULL,
  object_type    text NOT NULL,
  object_id      text,
  reason         text,
  origin         text,
  correlation_id text,
  metadata       jsonb NOT NULL DEFAULT '{}',
  happened_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_time ON audit_events (tenant_id, happened_at);

-- RF-006 / RNF-010: append-only. Updates, deletes and truncation are rejected at the database level.
CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER audit_events_no_update_delete BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

CREATE TABLE consent_records (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  patient_id uuid NOT NULL,
  purpose    text NOT NULL,
  version    text NOT NULL,
  source     text NOT NULL,
  granted    boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, patient_id) REFERENCES patients (tenant_id, id)
);

CREATE TABLE privacy_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  subject_ref text NOT NULL,
  type        text NOT NULL CHECK (type IN ('ACCESS', 'RECTIFICATION', 'ERASURE', 'EXPORT')),
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_REVIEW', 'COMPLETED', 'REJECTED')),
  decision    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);

CREATE TABLE usage_ledger (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  provider  text NOT NULL,
  units     numeric NOT NULL CHECK (units >= 0),
  cost_usd_micros bigint NOT NULL DEFAULT 0 CHECK (cost_usd_micros >= 0),  -- integer micro-USD, never float money
  period    text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
