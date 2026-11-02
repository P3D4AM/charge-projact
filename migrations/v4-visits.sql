-- Migration v3 -> v4: گزارش بازدید و ورود به مینی‌اپ
-- اجرا روی دیتابیس موجود:
--   wrangler d1 execute building-charges --remote --file=./migrations/v4-visits.sql
-- (deploy:auto هم schema.sql را دوباره اجرا می‌کند و همین جدول ساخته می‌شود)

CREATE TABLE IF NOT EXISTS visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,              -- open | login
  via        TEXT DEFAULT '',            -- telegram | web | session
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visits_user ON visits(user_id);
CREATE INDEX IF NOT EXISTS idx_visits_time ON visits(created_at);
