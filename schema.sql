-- D1 schema v2 — Telegram Building Charges Mini App
-- v2: سیستم کاربران با نام کاربری/رمز عبور و سه نقش (admin | manager | resident)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS units (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  number           TEXT NOT NULL UNIQUE,
  resident_name    TEXT DEFAULT '',
  phone            TEXT DEFAULT '',
  area_m2          REAL NOT NULL DEFAULT 0,
  residents_count  INTEGER NOT NULL DEFAULT 1,
  note             TEXT DEFAULT '',
  auto_charge      INTEGER NOT NULL DEFAULT 0,  -- v13: تیک شارژ خودکار ماهانه
  created_at       INTEGER NOT NULL
);

-- هر شخص (ادمین اپ، مدیر ساختمان، ساکن) یک حساب کاربری با نام کاربری و رمز دارد
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'resident',  -- admin | manager | resident
  full_name         TEXT DEFAULT '',
  phone             TEXT DEFAULT '',
  unit_id           INTEGER REFERENCES units(id) ON DELETE CASCADE,
  telegram_user_id  INTEGER,
  telegram_username TEXT DEFAULT '',
  is_active         INTEGER NOT NULL DEFAULT 1,
  token_epoch       INTEGER NOT NULL DEFAULT 0,  -- v2.14.0: bumped on password change
  bound_tg_id       INTEGER,                     -- v2.17.0: قفل حساب به پروفایل لینک دعوت یک‌بارمصرف
  is_resident       INTEGER NOT NULL DEFAULT 1,  -- v2.17.0: مدیر ساکن است؟ (۰ = از بدهکاران/یادآوری مستثنی)
  created_by        INTEGER,
  created_at        INTEGER NOT NULL
);

-- v9 (v2.17.0): لینک دعوت یک‌بارمصرف اتصال تلگرام — مقدار startapp در t.me/<bot>?startapp=…
CREATE TABLE IF NOT EXISTS invite_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by  INTEGER,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  used_by_tg  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_invite_token ON invite_tokens(token);
CREATE INDEX IF NOT EXISTS idx_invite_user  ON invite_tokens(user_id);

CREATE TABLE IF NOT EXISTS expenses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  category   TEXT DEFAULT 'سایر',
  amount     INTEGER NOT NULL,
  period     TEXT NOT NULL,
  split_mode TEXT NOT NULL DEFAULT 'equal', -- equal | area
  spent_at   INTEGER,
  note       TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS debts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id     INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'monthly',  -- monthly | expense | custom
  expense_id  INTEGER REFERENCES expenses(id) ON DELETE CASCADE,
  period      TEXT NOT NULL,                    -- e.g. 1404-07 (Jalali)
  description TEXT DEFAULT '',
  amount      INTEGER NOT NULL,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'unpaid',   -- unpaid | partial | paid
  paid_at     INTEGER,
  method      TEXT DEFAULT '',
  note        TEXT DEFAULT '',
  remind_count INTEGER NOT NULL DEFAULT 0,  -- v2.14.0: تعداد یادآوری
  last_remind_at INTEGER,                   -- v2.14.0: آخرین یادآوری (unix)
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_debts_unit      ON debts(unit_id);
CREATE INDEX IF NOT EXISTS idx_debts_period    ON debts(period);
CREATE INDEX IF NOT EXISTS idx_debts_status    ON debts(status);
CREATE INDEX IF NOT EXISTS idx_debts_expense   ON debts(expense_id);
CREATE INDEX IF NOT EXISTS idx_expenses_period ON expenses(period);
CREATE INDEX IF NOT EXISTS idx_users_unit      ON users(unit_id);
CREATE INDEX IF NOT EXISTS idx_users_telegram  ON users(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_users_role      ON users(role);

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

-- v4: گزارش بازدید و ورود به مینی‌اپ — هر بار باز کردن اپ / ورود با رمز یک ردیف
CREATE TABLE IF NOT EXISTS visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,              -- open | login
  via        TEXT DEFAULT '',            -- telegram | web | session
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visits_user ON visits(user_id);
CREATE INDEX IF NOT EXISTS idx_visits_time ON visits(created_at);

-- v5: گزارش پیام‌های بات — v2.19.0: پیام‌های «ارسالی» ربات هم (یادآوری خودکار/دستی،
-- پیام شخصی، اعلان، اعلام رسید/کار/بازدید، پاسخ‌های وب‌هوک) کنار دریافتی‌ها ثبت می‌شوند
CREATE TABLE IF NOT EXISTS bot_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  chat_type   TEXT NOT NULL DEFAULT 'private',  -- private | group | supergroup
  tg_user_id  INTEGER,
  username    TEXT DEFAULT '',
  full_name   TEXT DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'text',     -- command | text | other | out
  title       TEXT NOT NULL DEFAULT '',         -- «فرمان /start» | «پیام متنی» | «یادآوری خودکار» | ...
  text        TEXT DEFAULT '',                  -- متن پیام (حداکثر ۵۰۰ کاراکتر)
  direction   TEXT NOT NULL DEFAULT 'in',       -- v10: in (دریافتی از کاربر) | out (ارسالی ربات)
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_messages_time  ON bot_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_bot_messages_title ON bot_messages(title);
CREATE INDEX IF NOT EXISTS idx_bot_messages_user  ON bot_messages(tg_user_id);
CREATE INDEX IF NOT EXISTS idx_bot_messages_dir   ON bot_messages(direction);

-- v6: دفتر کارهای مدیر ساختمان — ثبت کارهای انجام‌شده در طول سال، هزینهٔ هر کار
-- (از صندوق کسر می‌شود) و مدارک پیوست (فیش، قرارداد، برگه بازدید آسانسور و…)
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'سایر',
  description TEXT DEFAULT '',
  cost        INTEGER NOT NULL DEFAULT 0,   -- تومان؛ از صندوق ساختمان کسر می‌شود
  done_at     INTEGER,                      -- تاریخ انجام (unix, تهران)
  created_by  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks(done_at);

-- متادیتای مدارک پیوست کارها
CREATE TABLE IF NOT EXISTS task_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  mime       TEXT DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_files_task ON task_files(task_id);

-- محتوای فایل در قطعات ~۶۰ کیلوبایتی (سقف طول گزارهٔ D1) — هنگام دانلود
-- به ترتیب idx دوباره سرهم می‌شود
CREATE TABLE IF NOT EXISTS task_file_chunks (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  idx     INTEGER NOT NULL,
  data    BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_chunks_file ON task_file_chunks(file_id, idx);

-- v8: رسیدهٔ پرداخت شارژ — ساکن فیش واریزی را با توضیح بارگذاری می‌کند؛ مدیر
-- فایل را می‌بیند و پرداخت را کامل یا جزیی ثبت می‌کند (مانده بدهی می‌ماند)
CREATE TABLE IF NOT EXISTS payment_claims (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id          INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  user_id          INTEGER,                       -- حساب ساکن ثبت‌کننده
  amount           INTEGER NOT NULL DEFAULT 0,    -- مبلغ اعلام‌شده توسط ساکن (تومان)
  note             TEXT DEFAULT '',               -- توضیح ساکن (کامل/جزیی و…)
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | rejected
  confirmed_amount INTEGER,                       -- مبلغ ثبت‌شده توسط مدیر
  reject_note      TEXT DEFAULT '',               -- دلیل رد (اختیاری)
  confirmed_by     INTEGER,
  created_at       INTEGER NOT NULL,
  confirmed_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_claims_unit   ON payment_claims(unit_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON payment_claims(status);

-- فیش واریزی آپلودشدهٔ ساکن (هر رسید یک فایل) + محتوای قطعه‌قطعه
CREATE TABLE IF NOT EXISTS claim_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id   INTEGER NOT NULL,
  name       TEXT NOT NULL,
  mime       TEXT DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claim_files_claim ON claim_files(claim_id);

CREATE TABLE IF NOT EXISTS claim_file_chunks (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  idx     INTEGER NOT NULL,
  data    BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claim_chunks_file ON claim_file_chunks(file_id, idx);

-- v11 (v2.21.0): اعتبار اضافه‌پرداخت — دفتر تراکنش؛ مثبت = ثبت اضافه‌پرداخت،
-- منفی = مصرف اعتبار (مثلاً در صدور شارژ ماه بعد). مانده = SUM(amount).
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

-- v12 (v2.22.0): گزارش کامل اعلان‌های فعالیت مدیرکل — هر رویداد تیک‌خوردهٔ پنل
-- ادمین یک ردیف می‌سازد (متن کامل پیام + انجام‌دهنده + وضعیت ارسال تلگرام).
CREATE TABLE IF NOT EXISTS admin_notifications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event            TEXT NOT NULL,
  title            TEXT NOT NULL DEFAULT '',
  text             TEXT NOT NULL,
  actor_user_id    INTEGER,
  actor_username   TEXT DEFAULT '',
  actor_role       TEXT DEFAULT '',
  unit_id          INTEGER,
  unit_number      TEXT DEFAULT '',
  ref_id           INTEGER,
  meta             TEXT DEFAULT '',
  sent             INTEGER NOT NULL DEFAULT 0,
  send_error       TEXT DEFAULT '',
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_notif_event ON admin_notifications(event);
CREATE INDEX IF NOT EXISTS idx_admin_notif_time  ON admin_notifications(created_at);

-- v13 (v2.23.0): یادآوری‌های دوره‌ای که مدیرکل از پنل برای مدیر ساختمان می‌سازد؛
-- cron روزانه سررسیدها را می‌سنجد و با ربات برای مدیر می‌فرستد.
CREATE TABLE IF NOT EXISTS manager_reminders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT NOT NULL,
  text              TEXT DEFAULT '',
  freq              TEXT NOT NULL DEFAULT 'monthly',
  weekday           INTEGER,
  month_day         INTEGER,
  is_active         INTEGER NOT NULL DEFAULT 1,
  last_sent_at      INTEGER,
  last_sent_day     TEXT DEFAULT '',
  last_sent_period  TEXT DEFAULT '',
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mreminders_active ON manager_reminders(is_active);
