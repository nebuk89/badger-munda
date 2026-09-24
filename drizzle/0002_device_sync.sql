ALTER TABLE badge_credentials
  ADD COLUMN IF NOT EXISTS first_used_at timestamptz;

CREATE TABLE IF NOT EXISTS badge_presence (
  badge_id text PRIMARY KEY REFERENCES badges(id) ON DELETE CASCADE,
  boot_id text NOT NULL,
  firmware_version text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  known_station_revision bigint,
  fps double precision,
  last_error_code text,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS badge_receipts (
  badge_id text PRIMARY KEY REFERENCES badges(id) ON DELETE CASCADE,
  station_revision bigint NOT NULL,
  command_seq bigint NOT NULL,
  playback_generation bigint NOT NULL,
  frame_id bigint NOT NULL,
  received_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS content_versions (
  catalog_hash text PRIMARY KEY,
  catalog_url text NOT NULL UNIQUE,
  blob_base_url text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS content_versions_one_active
  ON content_versions (active)
  WHERE active;

CREATE TABLE IF NOT EXISTS device_sync_limits (
  badge_id text PRIMARY KEY REFERENCES badges(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL,
  blocked_until timestamptz
);
