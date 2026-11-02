-- v3: نظرسنجی‌های مدیر ساختمان — هر واحد یک رأی
CREATE TABLE IF NOT EXISTS polls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  options    TEXT NOT NULL,                 -- JSON array of option strings
  status     TEXT NOT NULL DEFAULT 'open',  -- open | closed
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  closed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS poll_votes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id      INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  unit_id      INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  user_id      INTEGER,
  option_index INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(poll_id, unit_id)
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_unit ON poll_votes(unit_id);
