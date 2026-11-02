-- Migration v8 -> v9 (v2.17.0):
-- ۱) لینک دعوت یک‌بارمصرف تلگرام برای اتصال حساب‌ها + قفل نشست به همان پروفایل
-- ۲) پرچم «مدیر ساکن ساختمان است» — مدیر ساکن جزو بدهکاران شارژ و یادآوری‌هاست
--    مگر اینکه در پنل مدیریت اپ تیک «مدیر، ساکن ساختمان نیست» بخورد.
--
-- اجرا روی دیتابیس موجود:
--   wrangler d1 execute building-charges --remote --file=./migrations/v9-invites-resident.sql
-- (deploy:auto همین فایل را اجرا می‌کند؛ اجرای مکرر امن است)

CREATE TABLE IF NOT EXISTS invite_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL UNIQUE,             -- مقدار startapp در لینک t.me
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by  INTEGER,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,                 -- زمان انقضای انتخاب‌شده
  used_at     INTEGER,                          -- با اولین بازکردن لینک ثبت می‌شود
  used_by_tg  INTEGER                           -- شناسهٔ پروفایل تلگرامی که لینک را باز کرد
);
CREATE INDEX IF NOT EXISTS idx_invite_token ON invite_tokens(token);
CREATE INDEX IF NOT EXISTS idx_invite_user  ON invite_tokens(user_id);

-- قفل حساب به پروفایل تلگرامِی که لینک یک‌بارمصرف را باز کرده است
ALTER TABLE users ADD COLUMN bound_tg_id INTEGER;

-- فقط برای نقش manager معنا دارد: ۱ = مدیر ساکن است (جزو بدهکاران/یادآوری)، ۰ = ساکن نیست
ALTER TABLE users ADD COLUMN is_resident INTEGER NOT NULL DEFAULT 1;
