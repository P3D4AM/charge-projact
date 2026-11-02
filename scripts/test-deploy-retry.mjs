// v2.17.1 — تست عملیاتی «تلاش مجدد خودکار روی خطای شبکه» در scripts/deploy.mjs
// بدون اتصال به Cloudflare: wrangler واقعی موقتاً با یک wrangler ساختگی جایگزین می‌شود
// که سناریوهای خطا را شبیه‌سازی می‌کند. در پایان همه‌چیز برمی‌گردد به حالت قبل.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = path.join(ROOT, 'wrangler.jsonc');
const STATE = path.join(ROOT, 'out', '.fake-wrangler-state');
const FAKE = `// fake wrangler for retry tests
const fs = require('fs');
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_STATE;
const mode = process.env.FAKE_MODE || 'transient';
const key = (args[0] === 'd1' ? args[0] + ' ' + args[1] : args[0]);
let st = {};
try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
st[key] = (st[key] || 0) + 1;
fs.writeFileSync(stateFile, JSON.stringify(st));
const netErr = () => {
  console.error('\\u25b2 [WARNING] A fetch request failed, likely due to a connectivity issue.');
  console.error('X [ERROR] fetch failed');
  process.exit(1);
};
const authErr = () => { console.error('X [ERROR] code: 10000, Authentication error'); process.exit(1); };
const okWhoami = () => { console.log('Test Account\\nAccount ID: aabbccdd00112233aabbccdd00112233'); process.exit(0); };
if (mode === 'always-net') netErr();
if (mode === 'auth-error') { if (key === 'whoami') authErr(); okWhoami(); }
// mode = transient
if (key === 'whoami') { if (st[key] <= 2) netErr(); okWhoami(); } // دوبار قطعی → بنر تلاش دوم ظاهر شود
if (key === 'd1 list') { console.log(JSON.stringify([{ uuid: '11111111-2222-3333-4444-555555555555', name: 'building-charges' }])); process.exit(0); }
if (key === 'd1 execute') {
  const ci = args.indexOf('--command');
  const sql = ci >= 0 ? args[ci + 1] : '';
  const isFile = args.some(function (a) { return String(a).indexOf('--file') === 0; });
  const fk = isFile ? 'd1 execute file' : 'd1 execute cmd';
  st[fk] = (st[fk] || 0) + 1;
  fs.writeFileSync(stateFile, JSON.stringify(st));
  if (mode === 'drift') {
    // v2.20.1 — دیتابیس قدیمی: bot_messages بدون direction و users بدون is_resident
    if (sql.indexOf('pragma_table_info') >= 0) {
      const bm = ['id','chat_id','chat_type','tg_user_id','username','full_name','kind','title','text','created_at'];
      const us = ['id','username','password_hash','role','full_name','phone','unit_id','telegram_user_id','telegram_username','is_active','token_epoch','bound_tg_id','created_by','created_at'];
      const blocks = [{ results: bm.map(function (c) { return { tbl: 'bot_messages', col: c }; }), success: true },
                      { results: us.map(function (c) { return { tbl: 'users', col: c }; }), success: true }];
      console.log(JSON.stringify(blocks)); process.exit(0);
    }
    if (sql.indexOf('ALTER TABLE') >= 0) {
      st.alter = (st.alter || 0) + 1;
      fs.writeFileSync(stateFile, JSON.stringify(st));
      console.log(JSON.stringify([{ results: [], success: true }])); process.exit(0);
    }
    if (isFile) {
      if ((st.alter || 0) >= 1) { console.log('Executed schema.sql successfully.'); process.exit(0); }
      // اگر reconcile قبل از schema.sql اجرا نشده باشد — دقیقاً خطای کاربر:
      console.error('X [ERROR] no such column: direction at offset 67: SQLITE_ERROR'); process.exit(1);
    }
    console.log('ok'); process.exit(0);
  }
  if (isFile && st[fk] === 1) netErr(); // فقط اولین اجرای schema.sql قطع می‌شود (probeها مزاحم سناریوهای قبلی نیستند)
  console.log(isFile ? '\\u2705 Executed schema.sql successfully.' : 'ok');
  process.exit(0);
}
if (key === 'deploy') { console.log('Uploaded\\nhttps://building-charges.test.workers.dev'); process.exit(0); }
console.log('ok'); process.exit(0);
`;

const results = [];
const tt = (name, cond) => { results.push(cond); console.log(`  ${cond ? '\x1b[32m[ok]\x1b[0m' : '\x1b[31m[x]\x1b[0m'} ${name}`); };

const realWranglerSrc = fs.readFileSync(REAL_WRANGLER, 'utf8');
const realConfig = fs.readFileSync(CONFIG, 'utf8');
fs.mkdirSync(path.dirname(STATE), { recursive: true });

const run = (env) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'deploy.mjs')], {
  cwd: ROOT, encoding: 'utf8', timeout: 300000,
  env: { ...process.env, DEPLOY_CI: '1', DEPLOY_LANG: 'en', ...env }
});

try {
  fs.writeFileSync(REAL_WRANGLER, FAKE);

  // --- سناریو ۱: قطعی گذرا در whoami و d1 execute → خودکار رفع و دیپلوی کامل ---
  fs.rmSync(STATE, { force: true });
  let r = run({ FAKE_MODE: 'transient', FAKE_STATE: STATE, FAKE_WC: '1' });
  const o1 = (r.stdout || '') + (r.stderr || '');
  tt('scenario 1: transient network blip → retry succeeds, deploy completes (exit 0)', r.status === 0);
  tt('scenario 1: whoami retried (Attempt 2 ok message)', o1.includes('Attempt 2 for "Cloudflare login check" succeeded'));
  tt('scenario 1: d1 execute retried (Attempt 2 ok message)', o1.includes('Attempt 2 for "Applying schema.sql to D1" succeeded'));
  tt('scenario 1: retry wait message shown', /Attempt 1\/\d+ for "Applying schema\.sql to D1" hit a network error/.test(o1));
  tt('scenario 1: DEPLOYMENT COMPLETE', o1.includes('DEPLOYMENT COMPLETE'));
  tt('scenario 1: db id wired from fake d1 list', o1.includes('11111111-2222-3333-4444-555555555555'));

  // --- سناریو ۲: قطعی پایدار → تلاش‌ها طبق DEPLOY_ATTEMPTS و سپس پیام روشن ---
  fs.rmSync(STATE, { force: true });
  r = run({ FAKE_MODE: 'always-net', FAKE_STATE: STATE, DEPLOY_ATTEMPTS: '2' });
  const o2 = (r.stdout || '') + (r.stderr || '');
  tt('scenario 2: persistent network failure → dies (exit 1)', r.status === 1);
  tt('scenario 2: attempts honored (warn Attempt 1/2)', o2.includes('Attempt 1/2 for "Cloudflare login check"'));
  tt('scenario 2: clear final message with cause', o2.includes('failed after 2 attempt(s) (network error reaching api.cloudflare.com)'));
  tt('scenario 2: rerun guidance shown', o2.includes('re-run "npm run deploy:auto"'));

  // --- سناریو ۳: خطای غیرشبکه‌ای → بدون تلاش مجدد، مسیر قبلی (پیام CI) ---
  fs.rmSync(STATE, { force: true });
  r = run({ FAKE_MODE: 'auth-error', FAKE_STATE: STATE });
  const o3 = (r.stdout || '') + (r.stderr || '');
  tt('scenario 3: non-network error → no retry, original CI guidance (exit 1)', r.status === 1 && o3.includes('CLOUDFLARE_API_TOKEN') && !/Attempt 1\//.test(o3));

  // --- سناریو ۴ (v2.20.1): دیتابیس قدیمی بدون ستون direction → reconcile خودکار قبل از schema.sql ---
  fs.rmSync(STATE, { force: true });
  r = run({ FAKE_MODE: 'drift', FAKE_STATE: STATE });
  const o4 = (r.stdout || '') + (r.stderr || '');
  tt('scenario 4: old-db drift → reconcile runs, deploy completes (exit 0)', r.status === 0);
  tt('scenario 4: direction column added', o4.includes('Missing column added: bot_messages.direction'));
  tt('scenario 4: is_resident column added', o4.includes('Missing column added: users.is_resident'));
  tt('scenario 4: drift summary line', o4.includes('Schema drift fixed: 2 missing column(s) added'));
  tt('scenario 4: raw SQLITE error never surfaced', !o4.includes('no such column'));
  tt('scenario 4: DEPLOYMENT COMPLETE', o4.includes('DEPLOYMENT COMPLETE'));
  let st4 = {}; try { st4 = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  tt('scenario 4: exactly 2 ALTERs issued', st4.alter === 2);
} finally {
  fs.writeFileSync(REAL_WRANGLER, realWranglerSrc);
  fs.writeFileSync(CONFIG, realConfig);
  fs.rmSync(STATE, { force: true });
}

const bad = results.filter(a => !a).length;
console.log(bad
  ? `\n\x1b[31m[x] ${bad} test(s) failed\x1b[0m`
  : `\n\x1b[32m[ok] all ${results.length} tests passed\x1b[0m`);
process.exit(bad ? 1 : 0);
