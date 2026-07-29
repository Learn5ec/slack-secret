-- Track the sender's most recent "Viewed By" DM message so Revoke can delete it,
-- same as the recipient DM placeholder and the revealed-secret messages.
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS viewed_by_channel_id TEXT;
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS viewed_by_ts TEXT;
