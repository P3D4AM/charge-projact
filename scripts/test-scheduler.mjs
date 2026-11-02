// Unit tests for the automatic monthly reminder engine (src/scheduler.js):
// gate logic, template rendering, config parsing + a smoke test of the
// Worker's scheduled() cron handler (must never throw).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  gateAuto, renderRemindText, readAutoCfg, DEFAULT_REMIND_TEXT, REMIND_CAP
} from '../src/scheduler.js';
import worker from '../src/worker.js';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch { /* optional below */ }

let passed = 0;
const check = (name, cond) => {
  assert.ok(cond, name);
  passed++;
  console.log(`✔ ${name}`);
};

// ---------- 1) gate logic ----------
check('gate: disabled when not enabled', gateAuto(5, '1404-07', { enabled: false, day: 5, last: '' }) === 'disabled');
check('gate: day not reached', gateAuto(3, '1404-07', { enabled: true, day: 5, last: '' }) === 'day_not_reached');
check('gate: run on the exact day', gateAuto(5, '1404-07', { enabled: true, day: 5, last: '' }) === 'run');
check('gate: catch-up later in the month', gateAuto(28, '1404-07', { enabled: true, day: 5, last: '' }) === 'run');
check('gate: already sent this month', gateAuto(20, '1404-07', { enabled: true, day: 5, last: '1404-07' }) === 'already_sent');
check('gate: new month resets the marker', gateAuto(6, '1404-08', { enabled: true, day: 5, last: '1404-07' }) === 'run');

// ---------- 2) config parsing ----------
const cfg0 = readAutoCfg({});
check('cfg defaults: disabled', cfg0.enabled === false);
check('cfg defaults: day 1', cfg0.day === 1);
check('cfg defaults: default text', cfg0.text === DEFAULT_REMIND_TEXT);
check('cfg defaults: no last marker', cfg0.last === '');
check('cfg: day clamped to 29', readAutoCfg({ auto_reminder_day: '35' }).day === 29);
check('cfg: day clamped to 1', readAutoCfg({ auto_reminder_day: '-3' }).day === 1);
check('cfg: enabled=1 parsed', readAutoCfg({ auto_reminder_enabled: '1' }).enabled === true);
check('cfg: invalid last dropped', readAutoCfg({ auto_reminder_last: 'garbage' }).last === '');

// ---------- 3) template rendering ----------
const rendered = renderRemindText(
  '{building}|{name}|{unit}|{amount}|{month}',
  { building: 'برج نگین', name: 'علی', unit: '2', amount: 1234567, month: 'مهر ۱۴۰۴' }
);
check('render: all vars replaced (amount fa-formatted)', rendered === 'برج نگین|علی|2|۱,۲۳۴,۵۶۷|مهر ۱۴۰۴');
check('render: unknown var left as-is (visible typo)', renderRemindText('x {foo} y', {}) === 'x {foo} y');
check('render: defaults for missing vars', renderRemindText('{unit}|{amount}', {}) === '—|۰');
check('render: empty template safe', renderRemindText('', { unit: '5' }) === '');

// ---------- 4) scheduled() cron handler smoke tests ----------
// 4a) env without DB at all → must resolve (error swallowed + logged)
await worker.scheduled({}, { BOT_TOKEN: '' }, {});
check('scheduled: no DB → resolves without throwing', true);

// 4b) real in-memory D1-shaped env, nothing installed → gate returns 'disabled'
if (DatabaseSync) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = sql => ({
    bind: (...a) => ({ run: () => raw.prepare(sql).run(...a), first: () => raw.prepare(sql).get(...a), all: () => ({ results: raw.prepare(sql).all(...a) }) }),
    run: () => raw.prepare(sql).run(), first: () => raw.prepare(sql).get(), all: () => ({ results: raw.prepare(sql).all() })
  });
  const env = { DB: { prepare: sql => stmt(sql), batch: async s => { for (const x of s) x.run(); } }, BOT_TOKEN: '' };
  await worker.scheduled({}, env, {});
  check('scheduled: fresh install (reminder disabled) → silent skip, no crash', true);
} else {
  console.log('node:sqlite unavailable — skipping in-memory scheduled test');
}

// ---------- 5) cap constant sane ----------
check('cap: REMIND_CAP within free-plan subrequest budget', REMIND_CAP > 0 && REMIND_CAP <= 40);

console.log(`test-scheduler: ALL PASSED ✓ (${passed} checks)`);
