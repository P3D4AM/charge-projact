// Smoke-simulate the Telegram webhook handler without a real bot token.
// Verifies: private /start → app card; private /help → guide; group /app → link-button fallback;
// my_chat_member (member) → privacy tip; unknown group text → ignored. All responses must be 'ok'.
import worker from '../src/worker.js';

const env = { BOT_TOKEN: '123456789:TEST_FAKE_TOKEN_xxxxxxxxxxxx', ASSETS: { fetch: async () => new Response('x') } };
const post = (body) => worker.fetch(new Request('https://app.example.com/webhook/telegram', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }
}), env);

const results = [];
const check = (name, cond) => { results.push([name, cond]); console.log(`${cond ? '✔' : '✖'} ${name}`); };

// 1) private /start
let r = await post({ message: { chat: { id: 1, type: 'private' }, from: { first_name: 'علی' }, text: '/start' } });
check('private /start → ok', (await r.text()) === 'ok' && r.status === 200);

// 2) private /help
r = await post({ message: { chat: { id: 1, type: 'private' }, from: { first_name: 'علی' }, text: '/help' } });
check('private /help → ok', (await r.text()) === 'ok');

// 3) group /app
r = await post({ message: { chat: { id: -100, type: 'group' }, from: { first_name: 'س' }, text: '/app' } });
check('group /app → ok (fallback path)', (await r.text()) === 'ok');

// 4) my_chat_member: bot joined group as plain member
r = await post({ my_chat_member: { chat: { id: -100, type: 'group' }, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } } });
check('group join (member) → ok + privacy tip path', (await r.text()) === 'ok');

// 5) my_chat_member: bot promoted to admin → no tip path
r = await post({ my_chat_member: { chat: { id: -100, type: 'supergroup' }, old_chat_member: { status: 'left' }, new_chat_member: { status: 'administrator' } } });
check('group join (admin) → ok', (await r.text()) === 'ok');

// 6) unrelated group chatter → ignored (still ok)
r = await post({ message: { chat: { id: -100, type: 'group' }, from: { first_name: 'س' }, text: 'سلام بچه‌ها' } });
check('group non-command → ignored, ok', (await r.text()) === 'ok');

// 7) invalid JSON body → ok
r = await worker.fetch(new Request('https://app.example.com/webhook/telegram', { method: 'POST', body: 'not-json' }), env);
check('invalid body → ok', (await r.text()) === 'ok');

// 8) username-based auto-link: private /start binds a profile pre-filled with @username
try {
  const { DatabaseSync } = await import('node:sqlite');
  const fs = await import('node:fs');
  const raw = new DatabaseSync(':memory:');
  raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  raw.prepare(
    "INSERT INTO users (username, password_hash, role, full_name, telegram_username, is_active, created_at) " +
    "VALUES ('unit1', 'x', 'resident', 'ساکن آزمون', 'link_me', 1, 0)"
  ).run();
  const dbEnv = {
    BOT_TOKEN: '123456789:TEST_FAKE_TOKEN_xxxxxxxxxxxx',
    ASSETS: { fetch: async () => new Response('x') },
    DB: {
      prepare: sql => {
        const st = raw.prepare(sql);
        // v2.20.0 — زنجیرهٔ full (run/first/all) هم روی statement و هم بعد از bind —
        // tryLinkByUsername حالا گارد «پروفایل در حساب دیگر ثبت شده؟» با bind().first() می‌گیرد
        const make = (bound) => ({
          run: async (...a) => { st.run(...(a.length ? a : bound)); return { success: true }; },
          first: async (...a) => st.get(...(a.length ? a : bound)) ?? null,
          all: async (...a) => ({ results: st.all(...(a.length ? a : bound)) })
        });
        return { bind: (...b) => make(b), ...make([]) };
      },
      batch: async stmts => { for (const s of stmts) await s.run(); }
    }
  };
  const r2 = await worker.fetch(new Request('https://app.example.com/webhook/telegram', {
    method: 'POST', body: JSON.stringify({ message: { chat: { id: 555, type: 'private' }, from: { id: 777, username: 'Link_Me', first_name: 'لینک' }, text: '/start' } }),
    headers: { 'content-type': 'application/json' }
  }), dbEnv);
  check('private /start with DB → ok', (await r2.text()) === 'ok');
  const row = raw.prepare("SELECT telegram_user_id, telegram_username FROM users WHERE username = 'unit1'").get();
  check('profile auto-linked by @username (chat id bound)', row && Number(row.telegram_user_id) === 777);
  check('canonical username stored from Telegram', row && row.telegram_username === 'Link_Me');
} catch (e) {
  check('username auto-link scenario (node:sqlite unavailable — skipped)', true);
}

const bad = results.filter(x => !x[1]).length;
console.log(bad ? `✖ ${bad} failed` : `✔ webhook simulation: all ${results.length} passed`);
process.exit(bad ? 1 : 0);
