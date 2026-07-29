-- Create secrets table
CREATE TABLE IF NOT EXISTS secrets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id         TEXT NOT NULL,
  origin_channel_id TEXT NOT NULL,
  origin_ts         TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('text', 'file')),
  ciphertext        BYTEA,
  iv                BYTEA,
  file_path         TEXT,
  file_name         TEXT,
  file_size_bytes   BIGINT,
  allowed_viewer_id TEXT,
  visibility_mode   TEXT NOT NULL DEFAULT 'single' CHECK (visibility_mode IN ('single', 'multi')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired', 'cancelled')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL
);

-- Create views table
CREATE TABLE IF NOT EXISTS views (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_id     UUID NOT NULL REFERENCES secrets(id),
  viewer_id     TEXT NOT NULL,
  dm_channel_id TEXT,
  dm_ts         TEXT,
  delivered_at  TIMESTAMPTZ,
  delete_at     TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'delivered' CHECK (status IN ('delivered', 'deleted', 'failed')),
  UNIQUE (secret_id, viewer_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_views_delete_at ON views (delete_at) WHERE status = 'delivered';
CREATE INDEX IF NOT EXISTS idx_secrets_expiry ON secrets (expires_at) WHERE status = 'pending';
