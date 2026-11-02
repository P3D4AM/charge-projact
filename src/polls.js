// Polls (نظرسنجی) — building manager creates polls, every unit has one vote.
// Access: manager manages; any unit-linked user (resident or the manager's own
// unit) votes. One vote per (poll, unit) — a household decides together.
import { route } from './router.js';
import { json, fail, now } from './helpers.js';

const MAX_OPTIONS = 8;
const MAX_QUESTION = 160;
const MAX_OPTION_LEN = 80;

function parsePoll(row, votes) {
  let options = [];
  try { options = JSON.parse(row.options) || []; } catch { options = []; }
  const counts = options.map(() => 0);
  let myVote = null;
  const voters = [];
  for (const v of votes) {
    if (v.option_index >= 0 && v.option_index < options.length) counts[v.option_index]++;
    voters.push({ unit_id: v.unit_id, option_index: v.option_index });
  }
  return {
    id: row.id,
    question: row.question,
    options,
    counts,
    status: row.status,
    total_votes: votes.length,
    created_at: row.created_at,
    closed_at: row.closed_at,
    voters
  };
}

async function loadPoll(env, id) {
  const poll = await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(id).first();
  if (!poll) return null;
  const { results } = await env.DB.prepare(
    'SELECT * FROM poll_votes WHERE poll_id = ? ORDER BY id'
  ).bind(id).all();
  return parsePoll(poll, results || []);
}

// ---------------------------------------------------------------------------
// MANAGER — create / list / close / reopen / delete
// ---------------------------------------------------------------------------
route('POST', '/polls', async (c) => {
  const b = c.body || {};
  const question = String(b.question || '').trim().slice(0, MAX_QUESTION);
  let options = Array.isArray(b.options) ? b.options : [];
  options = options.map(o => String(o || '').trim().slice(0, MAX_OPTION_LEN)).filter(Boolean);
  if (!question) return fail('متن سؤال نظرسنجی را وارد کنید');
  if (options.length < 2) return fail('حداقل دو گزینه لازم است');
  if (options.length > MAX_OPTIONS) return fail(`حداکثر ${MAX_OPTIONS} گزینه مجاز است`);
  if (new Set(options).size !== options.length) return fail('گزینه‌های تکراری مجاز نیست');

  const res = await c.env.DB.prepare(`
    INSERT INTO polls (question, options, status, created_by, created_at)
    VALUES (?, ?, 'open', ?, ?)
  `).bind(question, JSON.stringify(options), c.user.id, now()).run();
  const poll = await loadPoll(c.env, res.meta.last_row_id);
  return json({ poll }, 201);
}, 'manager');

route('GET', '/polls', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM polls ORDER BY (status = 'open') DESC, id DESC LIMIT 100"
  ).all();
  const polls = [];
  for (const row of results || []) {
    const vres = await c.env.DB.prepare(
      'SELECT * FROM poll_votes WHERE poll_id = ? ORDER BY id'
    ).bind(row.id).all();
    const p = parsePoll(row, vres.results || []);
    // voters are internal (unit ids); strip for residents, keep counts only
    p.voters = c.role === 'manager' ? p.voters : undefined;
    p.my_vote = c.unit
      ? ((vres.results || []).find(v => v.unit_id === c.unit.id) || {}).option_index ?? null
      : null;
    polls.push(p);
  }
  return json({ polls });
}, 'user');

route('POST', '/polls/:id/close', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT id, status FROM polls WHERE id = ?').bind(id).first();
  if (!row) return fail('نظرسنجی پیدا نشد', 404);
  await c.env.DB.prepare("UPDATE polls SET status = 'closed', closed_at = ? WHERE id = ?")
    .bind(now(), id).run();
  return json({ poll: await loadPoll(c.env, id) });
}, 'manager');

route('POST', '/polls/:id/reopen', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT id FROM polls WHERE id = ?').bind(id).first();
  if (!row) return fail('نظرسنجی پیدا نشد', 404);
  await c.env.DB.prepare("UPDATE polls SET status = 'open', closed_at = NULL WHERE id = ?")
    .bind(id).run();
  return json({ poll: await loadPoll(c.env, id) });
}, 'manager');

route('DELETE', '/polls/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT id FROM polls WHERE id = ?').bind(id).first();
  if (!row) return fail('نظرسنجی پیدا نشد', 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM poll_votes WHERE poll_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM polls WHERE id = ?').bind(id)
  ]);
  return json({ ok: true });
}, 'manager');

// ---------------------------------------------------------------------------
// VOTE — any unit-linked user (resident / manager's own unit), one vote per unit
// ---------------------------------------------------------------------------
route('POST', '/polls/:id/vote', async (c) => {
  const id = Number(c.params.id);
  const poll = await c.env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(id).first();
  if (!poll) return fail('نظرسنجی پیدا نشد', 404);
  if (poll.status !== 'open') return fail('این نظرسنجی بسته شده است', 409);
  if (!c.unit) return fail('حساب شما به واحدی متصل نیست؛ رأی‌ها به تفکیک واحد ثبت می‌شود', 403, 'no_unit');

  const idx = Number((c.body || {}).option_index);
  let options = [];
  try { options = JSON.parse(poll.options) || []; } catch { /* ignore */ }
  if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) return fail('گزینه نامعتبر است');

  await c.env.DB.prepare(`
    INSERT INTO poll_votes (poll_id, unit_id, user_id, option_index, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(poll_id, unit_id) DO UPDATE SET option_index = excluded.option_index, user_id = excluded.user_id, created_at = excluded.created_at
  `).bind(id, c.unit.id, c.user.id, idx, now()).run();
  return json({ poll: await loadPoll(c.env, id) });
}, 'user');
