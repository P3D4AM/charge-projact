-- Migration v4 -> v5: گزارش پیام‌های دریافتی از بات تلگرام
-- اجرا روی دیتابیس موجود:
--   wrangler d1 execute building-charges --remote --file=./migrations/v5-bot-messages.sql
-- (deploy:auto هم schema.sql را دوباره اجرا می‌کند و همین جدول ساخته می‌شود)

CREATE TABLE IF NOT EXISTS bot_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  chat_type   TEXT NOT NULL DEFAULT 'private',  -- private | group | supergroup
  tg_user_id  INTEGER,
  username    TEXT DEFAULT '',
  full_name   TEXT DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'text',     -- command | text | other
  title       TEXT NOT NULL DEFAULT '',         -- «فرمان /start» | «پیام متنی» | ...
  text        TEXT DEFAULT '',                  -- متن پیام (حداکثر ۵۰۰ کاراکتر)
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_messages_time  ON bot_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_bot_messages_title ON bot_messages(title);
CREATE INDEX IF NOT EXISTS idx_bot_messages_user  ON bot_messages(tg_user_id);
