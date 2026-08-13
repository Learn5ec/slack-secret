-- Track initial "View Secret" DM placeholders sent to individual channel members.
-- Separate from `views` so that the placeholder delivery does NOT mark a message
-- as "viewed" - the placeholder is just the delivery vehicle; the actual secret
-- content is only revealed when the user clicks "View Secret".
CREATE TABLE IF NOT EXISTS channel_member_dms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_id UUID NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  dm_channel_id TEXT NOT NULL,
  dm_ts TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(secret_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_member_dms_secret_id ON channel_member_dms (secret_id);
