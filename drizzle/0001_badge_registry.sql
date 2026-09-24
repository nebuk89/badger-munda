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
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS badge_credentials_badge ON badge_credentials(badge_id);

CREATE TABLE IF NOT EXISTS badge_claims (
  id text PRIMARY KEY,
  badge_id text NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  code_hmac text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS badge_claims_code_expiry ON badge_claims(code_hmac, expires_at);
CREATE INDEX IF NOT EXISTS badge_claims_badge ON badge_claims(badge_id);

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS badge_id text REFERENCES badges(id) ON DELETE SET NULL;
