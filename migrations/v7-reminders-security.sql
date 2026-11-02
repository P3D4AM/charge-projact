-- v2.14.0 — «تعداد یادآوری» + امنیت حساب‌ها
--  1) debts.remind_count / last_remind_at: چند بار هر واحد برای همین اقلام
--     پرداخت‌نشده یادآوری گرفته و آخرین بار کِی (نمایش در گزارش‌ها و CSV)
--  2) users.token_epoch: با هر تغییر/ریست رمز یکی اضافه می‌شود و همهٔ نشست‌های
--     قبلیِ آن کاربر بی‌اعتبار می‌شوند (خروج اجباری از همه دستگاه‌ها)

ALTER TABLE debts ADD COLUMN remind_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE debts ADD COLUMN last_remind_at INTEGER;

ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;
