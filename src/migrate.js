// v2.14.0 — runtime schema self-migration (ضد فراموشی مهاجرت‌ها)
//
// deploy:auto applies schema.sql, but CREATE TABLE IF NOT EXISTS never adds
// columns to EXISTING production databases — so new columns (v7+) must be
// ensured at runtime. This runs once per isolate (WeakMap-cached per env):
// for each required column, a cheap SELECT probe; on failure, ALTER TABLE.
// Safe to call on every request path — concurrent isolates racing on the
// same ALTER are tolerated (duplicate column is swallowed).

const PROBE = Symbol.for('bc_schema_ensured');

async function ensure(env, table, column, ddl) {
  try {
    await env.DB.prepare(`SELECT ${column} FROM ${table} LIMIT 1`).run();
  } catch {
    try { await env.DB.prepare(ddl).run(); } catch { /* already added by a concurrent isolate */ }
  }
}

export function ensureSchema(env) {
  if (!env || !env.DB) return Promise.resolve();
  if (env[PROBE]) return env[PROBE];
  env[PROBE] = (async () => {
    // v7-reminders-security.sql
    await ensure(env, 'debts', 'remind_count', 'ALTER TABLE debts ADD COLUMN remind_count INTEGER NOT NULL DEFAULT 0');
    await ensure(env, 'debts', 'last_remind_at', 'ALTER TABLE debts ADD COLUMN last_remind_at INTEGER');
    await ensure(env, 'users', 'token_epoch', 'ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0');
    // v8-payment-claims.sql — جدول‌های جدید روی دیتابیس‌های قدیمی هم ساخته شوند
    await ensure(env, 'payment_claims', 'id', `CREATE TABLE IF NOT EXISTS payment_claims (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id          INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      user_id          INTEGER,
      amount           INTEGER NOT NULL DEFAULT 0,
      note             TEXT DEFAULT '',
      status           TEXT NOT NULL DEFAULT 'pending',
      confirmed_amount INTEGER,
      reject_note      TEXT DEFAULT '',
      confirmed_by     INTEGER,
      created_at       INTEGER NOT NULL,
      confirmed_at     INTEGER
    )`);
    await ensure(env, 'claim_files', 'id', `CREATE TABLE IF NOT EXISTS claim_files (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id   INTEGER NOT NULL,
      name       TEXT NOT NULL,
      mime       TEXT DEFAULT '',
      size       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    await ensure(env, 'claim_file_chunks', 'id', `CREATE TABLE IF NOT EXISTS claim_file_chunks (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      idx     INTEGER NOT NULL,
      data    BLOB NOT NULL
    )`);
    // v9-invites-resident.sql (v2.17.0) — لینک دعوت یک‌بارمصرف + مدیر ساکن/غیرساکن
    await ensure(env, 'invite_tokens', 'id', `CREATE TABLE IF NOT EXISTS invite_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token       TEXT NOT NULL UNIQUE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by  INTEGER,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      used_at     INTEGER,
      used_by_tg  INTEGER
    )`);
    await ensure(env, 'users', 'bound_tg_id', 'ALTER TABLE users ADD COLUMN bound_tg_id INTEGER');
    await ensure(env, 'users', 'is_resident', 'ALTER TABLE users ADD COLUMN is_resident INTEGER NOT NULL DEFAULT 1');
    // v10-outgoing-messages.sql (v2.19.0) — ثبت پیام‌های ارسالی ربات کنار دریافتی‌ها
    await ensure(env, 'bot_messages', 'direction', "ALTER TABLE bot_messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'in'");
    // v11-credits.sql (v2.21.0) — دفتر اعتبار اضافه‌پرداخت روی دیتابیس‌های قدیمی هم ساخته شود
    await ensure(env, 'unit_credits', 'id', `CREATE TABLE IF NOT EXISTS unit_credits (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id     INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      amount      INTEGER NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'add',
      debt_id     INTEGER,
      period      TEXT DEFAULT '',
      note        TEXT DEFAULT '',
      created_by  INTEGER,
      created_at  INTEGER NOT NULL
    )`);
    // v12-admin-notifs.sql (v2.22.0) — گزارش کامل اعلان‌های فعالیت مدیرکل
    await ensure(env, 'admin_notifications', 'id', `CREATE TABLE IF NOT EXISTS admin_notifications (
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
    )`);
    // v13-autocharge-mreminders.sql (v2.23.0) — تیک شارژ خودکار واحدها
    await ensure(env, 'units', 'auto_charge', 'ALTER TABLE units ADD COLUMN auto_charge INTEGER NOT NULL DEFAULT 0');
    // v13 (v2.23.0) — یادآوری‌های دوره‌ای مدیر ساختمان (ساخت از پنل ادمین)
    await ensure(env, 'manager_reminders', 'id', `CREATE TABLE IF NOT EXISTS manager_reminders (
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
    )`);
  })();
  return env[PROBE];
}
