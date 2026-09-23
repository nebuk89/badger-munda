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

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  session_id text,
  detail_json jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
