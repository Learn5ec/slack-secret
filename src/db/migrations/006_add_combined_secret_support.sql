-- Support secrets that carry BOTH text and a file (type = 'combined').
-- Text keeps using ciphertext/iv/encrypted_data_key; the file gets its own
-- dedicated envelope columns so both can coexist on one row.
DO $$
DECLARE
  existing_constraint text;
BEGIN
  SELECT con.conname INTO existing_constraint
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
  WHERE rel.relname = 'secrets' AND con.contype = 'c' AND att.attname = 'type';

  IF existing_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE secrets DROP CONSTRAINT %I', existing_constraint);
  END IF;
END $$;

ALTER TABLE secrets ADD CONSTRAINT secrets_type_check CHECK (type IN ('text', 'file', 'combined'));

ALTER TABLE secrets ADD COLUMN IF NOT EXISTS file_iv BYTEA;
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS file_encrypted_data_key BYTEA;

-- A combined secret's reveal is delivered as two Slack messages in the same
-- DM (text message + file upload) - track the file message's ts separately
-- from dm_ts (the text message) so both can be independently deleted.
ALTER TABLE views ADD COLUMN IF NOT EXISTS file_dm_ts TEXT;
