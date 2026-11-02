-- v11 (v2.21.0) — اعتبار اضافه‌پرداخت (دفتر تراکنش)
-- اگر ساکنی بیشتر از بدهی‌اش پرداخت کند (یا مدیر مبلغ اضافه را جداگانه ثبت کند)،
-- مابه‌التفاوت به‌عنوان «اعتبار» واحد ثبت می‌شود و در صدور شارژ ماه‌های بعدی
-- به‌صورت خودکار از آن کسر می‌شود.
-- هر ردیف یک تراکنش است: amount مثبت = ثبت اضافه‌پرداخت (kind=add)،
-- amount منفی = مصرف اعتبار (kind=consume، همراه debt_id قلم تسویه‌شده).
-- ماندهٔ اعتبار هر واحد = SUM(amount).
CREATE TABLE IF NOT EXISTS unit_credits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id     INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL,               -- + ثبت اضافه‌پرداخت | − مصرف اعتبار
  kind        TEXT NOT NULL DEFAULT 'add',    -- add | consume
  debt_id     INTEGER,                        -- قلم بدهی مصرف‌شده (برای kind=consume)
  period      TEXT DEFAULT '',                -- ماه مرتبط (اختیاری، مثلاً 1404-07)
  note        TEXT DEFAULT '',
  created_by  INTEGER,                        -- حساب مدیر ثبت‌کننده
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credits_unit ON unit_credits(unit_id);
