-- Add response_url column to views table for ephemeral message deletion
-- (Slack's chat.delete API cannot delete ephemeral messages; the only supported
-- way is POSTing {"delete_original": true} to the response_url that was live
-- when the ephemeral was posted.)
ALTER TABLE views ADD COLUMN IF NOT EXISTS response_url TEXT;

-- Track the recipient's "View Secret" DM placeholder so Revoke can delete it
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS recipient_dm_channel_id TEXT;
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS recipient_dm_ts TEXT;
