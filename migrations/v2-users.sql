-- Migration v1 -> v2: افزودن جدول کاربران (نام کاربری/رمز برای هر شخص)
-- اجرا روی دیتابیس موجود:
--   wrangler d1 execute building-charges --remote --file=./migrations/v2-users.sql
-- (اگر دیتابیس از قبل داده‌های آزمایشی دارد و اهمیتی ندارند، ساده‌تر است که از صفر بسازید)

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'resident',
  full_name         TEXT DEFAULT '',
  phone             TEXT DEFAULT '',
  unit_id           INTEGER REFERENCES units(id) ON DELETE CASCADE,
  telegram_user_id  INTEGER,
  telegram_username TEXT DEFAULT '',
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_by        INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_unit      ON users(unit_id);
CREATE INDEX IF NOT EXISTS idx_users_telegram  ON users(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_users_role      ON users(role);

-- حذف ستون قدیمی اتصال تلگرام از واحدها (اتصال حالا از طریق users انجام می‌شود)
ALTER TABLE units DROP COLUMN telegram_user_id;
