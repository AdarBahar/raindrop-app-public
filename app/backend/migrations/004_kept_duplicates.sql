-- Duplicate groups that the user chose to keep ("Keep all"). A kept group does not show again
-- while its bookmarks are the same. A new bookmark that joins the group (the same definite key, or for a
-- possible group the same possible key) makes the group show again.
-- group_hash is the SHA-256 (hex) of the section and the key of the group. A key can be a long URL,
-- so the hash keeps the primary key short.
CREATE TABLE IF NOT EXISTS kept_duplicates (
  user_id TEXT NOT NULL,
  group_hash TEXT NOT NULL,
  raindrop_ids BIGINT[] NOT NULL,
  kept_at TEXT NOT NULL,
  PRIMARY KEY (user_id, group_hash)
);

-- Give the runtime role its rights on the new table (see 003_bookmark_store.sql).
DO $$
DECLARE
  sch TEXT := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raindrop_app') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO raindrop_app', sch);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.kept_duplicates TO raindrop_app', sch);
  END IF;
END
$$;
