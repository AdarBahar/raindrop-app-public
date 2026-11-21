-- The time of the last successful "Check for new bookmarks" for each user. ISO text, like the other times.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_checked TEXT;
