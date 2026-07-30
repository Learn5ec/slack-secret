-- Track the sender's interactive placeholder message (View/Viewed By/Revoke)
-- so a background expiry sweep can delete it too, the same way Revoke does
-- with the live click context. Without this, a secret that naturally expires
-- (nobody views or revokes it) leaves a dead placeholder sitting forever.
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS sender_placeholder_channel_id TEXT;
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS sender_placeholder_ts TEXT;
