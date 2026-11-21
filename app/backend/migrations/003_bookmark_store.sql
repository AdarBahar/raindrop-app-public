-- The stored copy of the Raindrop bookmarks and folders of each user. See docs/bookmark-store-plan.md.
-- Raindrop stays the source of truth. A full sync fills these tables.
-- The raw column holds the complete Raindrop object. The app builds its items from raw only.
-- The typed columns are for checks and later SQL filters. Both change in one transaction.
-- This migration only adds tables, so a rollback to the previous release still works.

CREATE TABLE IF NOT EXISTS collections (
  user_id TEXT NOT NULL,
  id BIGINT NOT NULL,
  title TEXT NOT NULL,
  raw JSONB NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id TEXT NOT NULL,
  raindrop_id BIGINT NOT NULL,
  collection_id BIGINT,
  created TIMESTAMPTZ,
  raw JSONB NOT NULL,
  PRIMARY KEY (user_id, raindrop_id)
);

CREATE INDEX IF NOT EXISTS bookmarks_user_created ON bookmarks (user_id, created DESC);

-- One row for each user who started a sync. A null last_full_at means the user never synced.
-- A user with a last_full_at value and no bookmarks has an empty library.
CREATE TABLE IF NOT EXISTS sync_state (
  user_id TEXT PRIMARY KEY,
  last_full_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ
);

-- Give the runtime role its rights on the new tables. The default privileges of 001_init.sql
-- apply only to tables that the role of that migration creates, so the grants are repeated here.
-- The runtime role gets no CREATE right and no DDL right.
DO $$
DECLARE
  sch TEXT := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raindrop_app') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO raindrop_app', sch);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.collections, %I.bookmarks, %I.sync_state TO raindrop_app', sch, sch, sch);
  END IF;
END
$$;
