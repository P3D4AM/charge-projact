// v2.15.0 — round-trip test for lib/zip.js (buildZip + readZip + crc32)
import { buildZip, readZip, isZipBytes, safeEntryName, crc32 } from '../public/js/lib/zip.js';
import assert from 'node:assert';

const enc = new TextEncoder();
const json = JSON.stringify({ app: 'building-charges', units: [1, 2, 3], note: 'فارسی — متن آزمایشی' });
const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4, 250, 100]);

// 1) crc32 known vector
assert.equal(crc32(enc.encode('123456789')), 0xCBF43926, 'crc32 vector');

// 2) safeEntryName kills traversal but keeps real folder separators
assert.equal(safeEntryName('../../etc/passwd'), '_/_/etc/passwd');
assert.equal(safeEntryName('a/b\\c.png'), 'a/b_c.png');
assert.equal(safeEntryName(''), 'file');

// 3) build → magic + read round-trip
const zip = buildZip([
  { name: 'backup.json', data: enc.encode(json) },
  { name: 'files/1-receipt.png', data: png },
  { name: 'files/2-سند قرارداد.pdf', data: enc.encode('%PDF-1.4 test') }
]);
assert.ok(isZipBytes(zip), 'PK magic');
assert.ok(zip.length > 100, 'non-trivial size');

const entries = await readZip(zip);
assert.equal(entries.length, 3);
assert.equal(entries[0].name, 'backup.json');
assert.equal(new TextDecoder().decode(entries[0].data), json);
assert.deepEqual([...entries[1].data], [...png]);
assert.equal(new TextDecoder().decode(entries[2].data), '%PDF-1.4 test');

// 4) unicode name preserved
assert.ok(entries[2].name.includes('سند قرارداد'), 'utf-8 name');

// 5) empty zip → throw
assert.throws(() => buildZip([]), 'empty entries rejected');

// 6) garbage input → readZip throws (not crash)
await assert.rejects(() => readZip(enc.encode('not a zip at all')), 'garbage rejected');

// 7) truncated zip → throw
await assert.rejects(() => readZip(zip.slice(0, 30)), 'truncated rejected');

// 8) 250 entries ok
const many = Array.from({ length: 250 }, (_, i) => ({ name: 'files/f' + i + '.txt', data: enc.encode('x'.repeat(50)) }));
const bigZip = buildZip(many);
const bigRead = await readZip(bigZip);
assert.equal(bigRead.length, 250);

console.log('zip round-trip: all assertions passed,', zip.length, 'bytes sample zip');
