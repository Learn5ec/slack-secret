-- Channel recipient: the channel the secret was shared to.
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS channel_recipient_id TEXT;

-- Announcement in channel: tracked so it can be updated in-place on revoke/expiry.
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS channel_announcement_channel_id TEXT;
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS channel_announcement_ts TEXT;
