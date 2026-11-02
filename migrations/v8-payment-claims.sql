-- v8 — رسیدهٔ پرداخت شارژ (payment claims)
-- ساکن فیش واریزی خود را با توضیح بارگذاری می‌کند؛ مدیر ساختمان آن را می‌بیند،
-- فایل را بررسی می‌کند و پرداخت را کامل یا جزیی ثبت می‌کند (مانده بدهی می‌ماند).
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
