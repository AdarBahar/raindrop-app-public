-- The profile of a user: projects, interests, and one text about the user (docs/profile-plan.md, section 5).
-- The suggestion prompt can use the active entries. The table holds no Raindrop data, so a disconnect keeps it.
-- id is a BIGINT. pg returns it as text, and the code keeps it as text.
CREATE TABLE IF NOT EXISTS profile_entries (
  user_id TEXT NOT NULL,
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  kind TEXT NOT NULL CHECK (kind IN ('about', 'project', 'interest')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  -- The tag that the model can propose for this entry. NULL: the entry is context only.
  tag TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'github')),
  -- The stable ID of the source item. For GitHub: the numeric repository ID.
  source_ref TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

-- One "about" text for each user.
CREATE UNIQUE INDEX IF NOT EXISTS profile_entries_one_about
  ON profile_entries (user_id) WHERE kind = 'about';

-- An import cannot make a second entry for the same source item.
CREATE UNIQUE INDEX IF NOT EXISTS profile_entries_source
  ON profile_entries (user_id, source, source_ref) WHERE source_ref IS NOT NULL;

-- A tag names one entry of the user, in any letter case.
CREATE UNIQUE INDEX IF NOT EXISTS profile_entries_tag
  ON profile_entries (user_id, lower(tag)) WHERE tag IS NOT NULL;

-- Give the runtime role its rights on the new table (see 003_bookmark_store.sql).
DO $$
DECLARE
  sch TEXT := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raindrop_app') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO raindrop_app', sch);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.profile_entries TO raindrop_app', sch);
  END IF;
END
$$;
