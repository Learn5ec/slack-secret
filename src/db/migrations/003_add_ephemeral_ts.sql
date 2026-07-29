-- Add ephemeral_ts column to views table to track sender's ephemeral message
ALTER TABLE views
ADD COLUMN IF NOT EXISTS ephemeral_ts TEXT;

-- Update index to include ephemeral_ts
CREATE INDEX IF NOT EXISTS idx_views_delete_at_ephemeral
  ON views (delete_at) WHERE status = 'delivered' AND ephemeral_ts IS NOT NULL;
