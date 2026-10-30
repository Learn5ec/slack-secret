-- Explicit viewer allow-list. Lets a previously-1:1 secret be forwarded to
-- additional specific people WITHOUT widening it to "anyone holding the button"
-- (which is what flipping visibility_mode to 'multi' would do). A 'single'-mode
-- secret is viewable by its allowed_viewer_id OR anyone listed here.
-- ON DELETE CASCADE means purgeSecret/hardDeleteSecretsForId already clean it.
CREATE TABLE IF NOT EXISTS secret_allowed_viewers (
  secret_id  UUID NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  viewer_id  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (secret_id, viewer_id)
);

CREATE INDEX IF NOT EXISTS idx_secret_allowed_viewers_secret_id
  ON secret_allowed_viewers (secret_id);
