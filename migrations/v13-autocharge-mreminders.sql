-- v13 (v2.23.0) — صدور خودکار شارژ + یادآوری دوره‌ای مدیر ساختمان
-- ۱) تیک «شارژ خودکار» روی هر واحد — صدور خودکار ماهانه فقط برای واحدهای تیک‌خورده
-- ۲) جدول یادآوری‌های دوره‌ای که مدیرکل (مدیر اپ) از پنل برای مدیر ساختمان می‌سازد
ALTER TABLE units ADD COLUMN auto_charge INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS manager_reminders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT NOT NULL,             -- عنوان یادآوری
  text              TEXT DEFAULT '',           -- متن کامل (اختیاری)
  freq              TEXT NOT NULL DEFAULT 'monthly', -- daily | weekly | monthly
  weekday           INTEGER,                   -- هفتگی: ۰=شنبه … ۶=جمعه
  month_day         INTEGER,                   -- ماهانه: روز ۱ تا ۲۸ ماه شمسی
  is_active         INTEGER NOT NULL DEFAULT 1,
  last_sent_at      INTEGER,                   -- آخرین ارسال واقعی
  last_sent_day     TEXT DEFAULT '',           -- کلید روز شمسی (jy-mm-dd) آخرین ارسال
  last_sent_period  TEXT DEFAULT '',           -- ماه شمسی (jy-mm) آخرین ارسال
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mreminders_active ON manager_reminders(is_active);
