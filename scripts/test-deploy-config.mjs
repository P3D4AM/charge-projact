// Unit check for deploy.mjs's writeDbId regex behavior on wrangler.jsonc.
import fs from 'node:fs';
const path = '/home/z/my-project/telegram-building-charges/wrangler.jsonc';
const original = fs.readFileSync(path, 'utf8');
const id = '11111111-2222-3333-4444-555555555555';
const text = original.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${id}$2`);
const m = text.match(/"database_id"\s*:\s*"([^"]+)"/);
console.log('replaced ->', m && m[1]);
console.log('comment intact:', text.includes('بعد از اجرای'));
console.log('jsonc still parses (strip comments):', (() => {
  const bare = text.replace(/\/\/[^\n]*/g, '');
  try { JSON.parse(bare); return true; } catch (e) { return String(e); }
})());
