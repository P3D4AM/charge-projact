-- v10-outgoing-messages.sql (v2.19.0)
-- ثبت پیام‌های «ارسالی» ربات کنار دریافتی‌ها: ستون direction روی bot_messages
-- یادآوری خودکار/دستی، پیام شخصی، اعلان همگانی، اعلام رسید پرداخت/کار جدید/بازدید،
-- پیام آزمایشی و پاسخ‌های وب‌هوک همگی با direction='out' ذخیره می‌شوند.
-- دیتابیس‌های قدیمی: ردیف‌های موجود به‌صورت خودکار 'in' در نظر گرفته می‌شوند (پیش‌فرض).
ALTER TABLE bot_messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'in';

CREATE INDEX IF NOT EXISTS idx_bot_messages_dir ON bot_messages(direction);
