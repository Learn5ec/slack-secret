-- Track the delivered file copy's own file id (distinct from the message ts
-- that shares it) so it can be fully purged via files.delete, not just have
-- its sharing message removed via chat.delete (which leaves the underlying
-- file object intact - chat.delete only removes the message, not the file).
ALTER TABLE views ADD COLUMN IF NOT EXISTS file_upload_id TEXT;
