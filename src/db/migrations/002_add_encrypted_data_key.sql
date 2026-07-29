-- Add encrypted_data_key column to secrets table
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS encrypted_data_key BYTEA;
