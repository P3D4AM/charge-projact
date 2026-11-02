// v2.20.1 — تست عملیاتی «تطبیق drift اسکیما» روی D1 واقعیِ محلی (بدون نیاز به لاگین ابری)
//
// سناریو = دقیقاً همان اتفاقی که در دیپلوی v2.19/v2.20 کاربر افتاد:
//   ۱) دیتابیس قدیمی: bot_messages بدون ستون direction و users بدون is_resident
//   ۲) اعمال schema.sql → خطای «no such column: direction» (بازتولید باگ)
//   ۳) اجرای reconcile (probe + diff + ALTER) همان‌طور که deploy.mjs در گام ۳ می‌کند
//   ۴) اعمال مجدد schema.sql → موفق + ستون‌ها/ایندکس سر جایشان + اجرای دوباره = بدون تغییر
//
// ایزوله‌سازی: --persist-to یک پوشهٔ موقت محلی؛ به دیتابیس محلی dev و دیتابیس ابری دست نمی‌زند.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseSchemaTables, buildProbeCommand, extractProbeRows, diffMissingColumns
} from './schema-reconcile.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
// v2.22.0 — state موقت روی tmpdir سیستم (نه داخل مخزن) — روی فایل‌سیستم‌های
// حساس/شبکه‌ای هم پایدار است و مخزن را همیشه تمیز نگه می‌دارد
const PERSIST = path.join(os.tmpdir(), 'bc-d1-drift-test');
const DB = 'building-charges';

const results = [];
const tt = (name, cond) => { results.push(cond); console.log(`  ${cond ? '\x1b[32m[ok]\x1b[0m' : '\x1b[31m[x]\x1b[0m'} ${name}`); };

function d1(command, { expectFail = false, warmup = false } = {}) {
  const r = spawnSync(process.execPath, [WRANGLER, 'd1', 'execute', DB, '--local', '--json',
    '--persist-to', PERSIST, '--command', command, '-y'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const out = (r.stdout || '') + '\n' + (r.stderr || '');
  if (expectFail) return { ok: r.status === 0, out };
  // v2.22.0 — روی فایل‌سیستم‌های حساس (سندباکس/شبکه‌ای) workerd گاهی بار اول
  // SQLITE_IOERR_FSTAT می‌دهد؛ فقط برای warm-up، پوشهٔ state را پاک و یک‌بار دیگر تلاش کن
  if (warmup && r.status !== 0 && /SQLITE_IOERR|disk I\/O error/i.test(out)) {
    fs.rmSync(PERSIST, { recursive: true, force: true });
    return d1(command, { expectFail });
  }
  if (r.status !== 0) {
    console.error(out.trim().split('\n').slice(-12).join('\n'));
    console.error(`\n[x] local d1 execute failed: ${command.slice(0, 90)}...`);
    process.exit(1);
  }
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return { ok: true, out, parsed };
}

try {
  fs.rmSync(PERSIST, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(PERSIST), { recursive: true });

  // ۱) دیتابیس تازه از schema.sql فعلی
  d1(`SELECT 1`, { warmup: true }); // warm-up (state dir)
  const schemaFile = path.join(ROOT, 'schema.sql');
  const wr = spawnSync(process.execPath, [WRANGLER, 'd1', 'execute', DB, '--local',
    '--persist-to', PERSIST, '--file=./schema.sql', '-y'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  tt('fresh local db from current schema.sql', wr.status === 0);

  // ۲) شبیه‌سازی دیتابیس قدیمی (قبل از v10): حذف ستون‌های بعدی + ایندکس وابسته
  d1(`DROP INDEX IF EXISTS idx_bot_messages_dir;
      ALTER TABLE bot_messages DROP COLUMN direction;
      ALTER TABLE users DROP COLUMN is_resident;`);
  const colsAfter = extractProbeRows(d1(`SELECT 'bot_messages' AS tbl, name AS col FROM pragma_table_info('bot_messages');
      SELECT 'users' AS tbl, name AS col FROM pragma_table_info('users')`).parsed);
  tt('old-db simulation: direction & is_resident gone',
    !colsAfter.some((r) => r.col === 'direction') && !colsAfter.some((r) => r.col === 'is_resident'));

  // ۳) بازتولید باگ کاربر: اعمال schema.sql روی دیتابیس قدیمی باید بمیرد
  const wrFail = spawnSync(process.execPath, [WRANGLER, 'd1', 'execute', DB, '--local',
    '--persist-to', PERSIST, '--file=./schema.sql', '-y'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const failOut = (wrFail.stdout || '') + (wrFail.stderr || '');
  tt('bug reproduced: schema.sql fails with "no such column: direction"',
    wrFail.status !== 0 && /no such column: direction/i.test(failOut));

  // ۴) reconcile — همان مسیر deploy.mjs گام ۳
  const expected = parseSchemaTables(fs.readFileSync(schemaFile, 'utf8'));
  tt('parser read real schema.sql (15+ tables)', expected.size >= 15);
  const probe = d1(buildProbeCommand(expected.keys()));
  const rows = extractProbeRows(probe.parsed);
  tt('probe covers existing tables (invite_tokens) without direction',
    rows.some((r) => r.tbl === 'invite_tokens') && !rows.some((r) => r.col === 'direction'));
  const missing = diffMissingColumns(expected, rows);
  tt('drift detected: exactly direction + is_resident',
    missing.length === 2
    && missing.some((m) => m.table === 'bot_messages' && m.name === 'direction')
    && missing.some((m) => m.table === 'users' && m.name === 'is_resident'));
  tt('direction DDL carries NOT NULL DEFAULT in',
    missing.find((m) => m.name === 'direction')?.ddl === "ALTER TABLE 'bot_messages' ADD COLUMN 'direction' TEXT NOT NULL DEFAULT 'in'");
  tt('is_resident DDL carries NOT NULL DEFAULT 1',
    missing.find((m) => m.name === 'is_resident')?.ddl === "ALTER TABLE 'users' ADD COLUMN 'is_resident' INTEGER NOT NULL DEFAULT 1");
  for (const m of missing) d1(m.ddl);

  // ۵) اعمال مجدد schema.sql — این بار باید رد شود
  const wrFix = spawnSync(process.execPath, [WRANGLER, 'd1', 'execute', DB, '--local',
    '--persist-to', PERSIST, '--file=./schema.sql', '-y'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  tt('schema.sql now applies cleanly after reconcile', wrFix.status === 0);

  // ۶) راستی‌آزمایی ساختار نهایی
  const verify = d1(`SELECT name FROM pragma_table_info('bot_messages') WHERE name='direction';
      SELECT name FROM pragma_table_info('users') WHERE name='is_resident';
      SELECT name FROM sqlite_master WHERE type='index' AND name='idx_bot_messages_dir';
      SELECT dflt_value FROM pragma_table_info('bot_messages') WHERE name='direction'`).parsed;
  const flat = verify.flatMap((b) => b.results || []);
  tt('direction column present on bot_messages', flat.some((r) => r.name === 'direction'));
  tt('is_resident column present on users', flat.some((r) => r.name === 'is_resident'));
  tt('idx_bot_messages_dir index exists', flat.some((r) => r.name === 'idx_bot_messages_dir'));
  tt("direction default is 'in'", flat.some((r) => r.dflt_value === "'in'"));

  // ۷) idempotency — اجرای دوبارهٔ reconcile هیچ چیزی پیدا نمی‌کند
  const rows2 = extractProbeRows(d1(buildProbeCommand(expected.keys())).parsed);
  tt('reconcile is idempotent (second run finds nothing)', diffMissingColumns(expected, rows2).length === 0);
} finally {
  fs.rmSync(PERSIST, { recursive: true, force: true });
}

const bad = results.filter((a) => !a).length;
console.log(bad
  ? `\n\x1b[31m[x] ${bad} test(s) failed\x1b[0m`
  : `\n\x1b[32m[ok] all ${results.length} tests passed\x1b[0m`);
process.exit(bad ? 1 : 0);
