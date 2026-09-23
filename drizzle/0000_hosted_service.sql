CREATE TABLE IF NOT EXISTS admin_sessions (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  csrf_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  scope text NOT NULL,
  subject_hash text NOT NULL,
  window_started_at timestamptz NOT NULL,
  failures integer NOT NULL DEFAULT 0,
  blocked_until timestamptz,
  UNIQUE (scope, subject_hash)
);

CREATE TABLE IF NOT EXISTS stations (
  id text PRIMARY KEY,
  name text NOT NULL,
  revision bigint NOT NULL,
  next_command_seq bigint NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS broadcast_state (
  station_id text PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  clip_id text NOT NULL,
  paused boolean NOT NULL,
  loop boolean NOT NULL,
  started_at bigint NOT NULL,
  anchor_time bigint NOT NULL,
  position double precision NOT NULL,
  round integer NOT NULL,
  event_json jsonb,
  queue_json jsonb NOT NULL,
  playback_generation bigint NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  station_id text NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  command_seq bigint NOT NULL,
  request_id text NOT NULL,
  fingerprint text NOT NULL,
  action_json jsonb NOT NULL,
  resulting_revision bigint NOT NULL,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (station_id, request_id),
  UNIQUE (station_id, command_seq)
);

CREATE TABLE IF NOT EXISTS badges (
  id text PRIMARY KEY,
  label text NOT NULL,
  claimed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS badge_credentials (
  id text PRIMARY KEY,
  badge_id text NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  secret_hmac text NOT NULL UNIQUE,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  first_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS badge_claims (
  id text PRIMARY KEY,
  badge_id text NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  code_hmac text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS badge_claims_active_code ON badge_claims(code_hmac, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS badge_status (
  badge_id text PRIMARY KEY REFERENCES badges(id) ON DELETE CASCADE,
  boot_id text,
  firmware_version text,
  last_seen_at timestamptz NOT NULL,
  last_station_revision bigint,
  last_command_seq bigint,
  last_playback_generation bigint,
  last_asset_frame_id bigint,
  fps double precision,
  last_error_code text,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS content_versions (
  id text PRIMARY KEY,
  catalog_hash text NOT NULL UNIQUE,
  blob_prefix text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  badge_id text,
  session_id text,
  detail_json jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
