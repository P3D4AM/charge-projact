-- v5 (2026-09): لینک دعوت واحد — اتصال خودکار ساکن به اپ با لینک یک‌بارمصرف.
-- برای استقرارهای موجود: wrangler d1 execute building-charges --remote --file=./migrations/v5-invites.sql -y
-- (نکته: schema.sql کامل همین جدول‌ها را با IF NOT EXISTS دارد)
CREATE TABLE IF NOT EXISTS unit_invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT NOT NULL UNIQUE,
  unit_id    INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  used_by    INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_unit_invites_unit ON unit_invites(unit_id);
