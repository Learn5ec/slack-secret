-- Attribute each fan-out member DM to the entity that delivered it, so the
-- Manage modal can group recipients by channel / user group / group conversation
-- and revoke a whole entity at once. `recipient_kind` mirrors the delivery
-- worker's kind; `recipient_id` is the channel / usergroup / mpim id (NULL for
-- a direct person forward, which stays individually manageable).
ALTER TABLE channel_member_dms ADD COLUMN IF NOT EXISTS recipient_kind TEXT;
ALTER TABLE channel_member_dms ADD COLUMN IF NOT EXISTS recipient_id TEXT;

CREATE INDEX IF NOT EXISTS idx_channel_member_dms_recipient
  ON channel_member_dms (secret_id, recipient_kind, recipient_id);
