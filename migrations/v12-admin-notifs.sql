-- v12 (v2.22.0) — گزارش کامل اعلان‌های فعالیت برای مدیرکل (app-admin)
-- هر رویداد فعال‌شده (تیک در پنل ادمین) یک ردیف این جدول می‌سازد — مستقل از
-- موفقیت ارسال تلگرام؛ متن کامل پیام، انجام‌دهنده و وضعیت ارسال ذخیره می‌شود.
-- sent: ۰ = ارسال نشده (خطا/ربات تنظیم نیست/گیرنده‌ای متصل نیست)، ۱ = به همهٔ
-- مدیرکل‌های متصل رسید.
CREATE TABLE IF NOT EXISTS admin_notifications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event            TEXT NOT NULL,             -- کلید رویداد (resident_login, payment, …)
  title            TEXT NOT NULL DEFAULT '',  -- برچسب فارسی رویداد
  text             TEXT NOT NULL,             -- متن کامل پیام ارسالی به تلگرام
  actor_user_id    INTEGER,                   -- انجام‌دهنده (null = سیستم)
  actor_username   TEXT DEFAULT '',
  actor_role       TEXT DEFAULT '',
  unit_id          INTEGER,
  unit_number      TEXT DEFAULT '',
  ref_id           INTEGER,                   -- شناسهٔ مرجع (قلم/رسید/واحد/…)
  meta             TEXT DEFAULT '',           -- جزئیات بیشتر (JSON، اختیاری)
  sent             INTEGER NOT NULL DEFAULT 0,
  send_error       TEXT DEFAULT '',
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_notif_event ON admin_notifications(event);
CREATE INDEX IF NOT EXISTS idx_admin_notif_time  ON admin_notifications(created_at);
