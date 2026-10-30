-- A secret can announce in SEVERAL conversations: once per channel / group
-- conversation it is shared to, and once more per conversation it is forwarded
-- to. The old single `channel_announcement_*` columns could only track the last
-- one, so revoke/expiry only updated a single message. This table tracks every
-- announced conversation so they can all be updated in place.
CREATE TABLE IF NOT EXISTS channel_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_id UUID NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(secret_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_announcements_secret_id
  ON channel_announcements (secret_id);

-- Backfill any existing single-announcement references.
INSERT INTO channel_announcements (secret_id, channel_id, ts)
  SELECT id, channel_announcement_channel_id, channel_announcement_ts
  FROM secrets
  WHERE channel_announcement_channel_id IS NOT NULL
    AND channel_announcement_ts IS NOT NULL
  ON CONFLICT (secret_id, channel_id) DO NOTHING;
