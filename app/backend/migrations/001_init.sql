-- Schema for the Raindrop app. One database for all users.
-- Every table except users has a user_id column.
-- The admin role runs this file. The runtime role gets rights below.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  baseline INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raindrop_tokens (
  user_id TEXT PRIMARY KEY,
  access_enc TEXT NOT NULL,
  refresh_enc TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS visits (
  user_id TEXT NOT NULL,
  raindrop_id BIGINT NOT NULL,
  visit_count INTEGER NOT NULL,
  last_visit TEXT NOT NULL,
  PRIMARY KEY (user_id, raindrop_id)
);

CREATE TABLE IF NOT EXISTS known_items (
  user_id TEXT NOT NULL,
  raindrop_id BIGINT NOT NULL,
  PRIMARY KEY (user_id, raindrop_id)
);

CREATE TABLE IF NOT EXISTS new_items (
  user_id TEXT NOT NULL,
  raindrop_id BIGINT NOT NULL,
  PRIMARY KEY (user_id, raindrop_id)
);

CREATE TABLE IF NOT EXISTS classify_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  time TEXT NOT NULL,
  raindrop_id BIGINT NOT NULL,
  entry TEXT NOT NULL
);

-- Give the runtime role only the rights it needs. The role is created by the admin.
-- The runtime role gets no CREATE right and no DDL right.
-- The grants use the current schema, so a test schema works the same way.
DO $$
DECLARE
  sch TEXT := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raindrop_app') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO raindrop_app', sch);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO raindrop_app', sch);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO raindrop_app', sch);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO raindrop_app', sch);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO raindrop_app', sch);
  END IF;
END
$$;
