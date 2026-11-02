// Minimal ZIP toolkit (store + deflate-read) — v2.15.0
// Shared by the Cloudflare Worker (backup download) and the browser demo
// (backup build + restore) — same pattern as lib/pdf-core.js. No dependencies.
//
// Why: the backup must deliver «backup.json + attached documents» inside ONE
// .zip that downloads correctly in the Telegram WebView (server builds it,
// openLink hands it to the external browser). Restoring accepts that same zip.
//
// Security guards for reading foreign archives:
//   • entry count ≤ MAX_ENTRIES, total uncompressed ≤ MAX_TOTAL_BYTES
//   • entry names are sanitized (no path traversal, no absolute paths)
//   • compression methods: 0 (store) and 8 (deflate via DecompressionStream)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function isZipBytes(u8) {
  return u8 && u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4B &&
    (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07) &&
    (u8[3] === 0x04 || u8[3] === 0x06 || u8[3] === 0x08);
}

const MAX_ENTRIES = 500;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024; // 96MB — above any legit backup here

// DOS timestamp (local time, 2-second resolution) from a JS timestamp (ms)
function dosDateTime(ms) {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

function u16le(arr, v) { arr.push(v & 0xFF, (v >>> 8) & 0xFF); }
function u32le(arr, v) { arr.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }

function textBytes(s) {
  // UTF-8 bytes without TextEncoder (available everywhere, but keep it explicit)
  return new TextEncoder().encode(s);
}

/** Sanitize an entry name for the archive: keep flat-or-foldered structure but
 *  kill path traversal, backslashes and control chars. */
export function safeEntryName(name) {
  let s = String(name || 'file').replace(/[\u0000-\u001f]/g, '');
  const parts = s.split('/')
    .map(seg => seg.replace(/[\\]/g, '_').replace(/\.\./g, '_').replace(/^\.+/, '').trim())
    .filter(seg => seg && seg !== '.');
  return (parts.join('/') || 'file').slice(0, 120);
}

/**
 * Builds a ZIP archive (method 0 = store — attachments are images/PDFs that
 * barely compress and every runtime can write store without zlib access).
 * entries: [{ name: string, data: Uint8Array }]
 * Returns Uint8Array.
 */
export function buildZip(entries) {
  const list = (entries || []).filter(e => e && e.name && e.data && e.data.length >= 0);
  if (!list.length) throw new Error('هیچ محتوایی برای فایل فشرده نیست');
  const enc = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of list) {
    const nameB = enc.encode(safeEntryName(e.name));
    const data = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
    const crc = crc32(data);
    const { date, time } = dosDateTime(Date.now());

    const lh = [];
    u32le(lh, 0x04034b50);
    u16le(lh, 20);          // version needed
    u16le(lh, 0x0800);      // UTF-8 names flag
    u16le(lh, 0);           // method: store
    u16le(lh, time);
    u16le(lh, date);
    u32le(lh, crc);
    u32le(lh, data.length); // compressed (= stored)
    u32le(lh, data.length); // uncompressed
    u16le(lh, nameB.length);
    u16le(lh, 0);           // extra len
    localParts.push(new Uint8Array(lh), nameB, data);

    const ch = [];
    u32le(ch, 0x02014b50);
    u16le(ch, 20);          // version made by
    u16le(ch, 20);          // version needed
    u16le(ch, 0x0800);      // UTF-8 flag
    u16le(ch, 0);           // method
    u16le(ch, time);
    u16le(ch, date);
    u32le(ch, crc);
    u32le(ch, data.length);
    u32le(ch, data.length);
    u16le(ch, nameB.length);
    u16le(ch, 0);           // extra
    u16le(ch, 0);           // comment
    u16le(ch, 0);           // disk number
    u16le(ch, 0);           // internal attrs
    u32le(ch, 0);           // external attrs
    u32le(ch, offset);      // local header offset
    centralParts.push(new Uint8Array(ch), nameB);

    offset += lh.length + nameB.length + data.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = [];
  u32le(eocd, 0x06054b50);
  u16le(eocd, 0);
  u16le(eocd, 0);
  u16le(eocd, list.length);
  u16le(eocd, list.length);
  u32le(eocd, centralSize);
  u32le(eocd, offset); // central directory offset
  u16le(eocd, 0);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of [...localParts, ...centralParts, new Uint8Array(eocd)]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// ---- reading ----------------------------------------------------------------
function view(u8, off, len) { return u8.subarray(off, off + len); }
function rd16(u8, off) { return u8[off] | (u8[off + 1] << 8); }
function rd32(u8, off) { return (u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24)) >>> 0; }

async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('پشتیبانی فشرده‌سازی ZIP در این مرورگر نیست — از فایل ZIP ساخته‌شده توسط همین اپ استفاده کنید');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Reads a ZIP archive. Returns Promise<Array<{name, data: Uint8Array}>>.
 * Handles method 0 (store) and 8 (deflate). Rejects archives that exceed the
 * safety limits above.
 */
export async function readZip(u8) {
  if (!isZipBytes(u8)) throw new Error('فایل ZIP معتبر نیست');
  // locate End Of Central Directory (scan last 64KB + 22 bytes)
  const minEOCD = 22;
  let eocd = -1;
  const scanStart = Math.max(0, u8.length - minEOCD - 65535);
  for (let i = u8.length - minEOCD; i >= scanStart; i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4B && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ساختار فایل ZIP کامل نیست');
  const count = rd16(u8, eocd + 10);
  let cdOff = rd32(u8, eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('فایل ZIP بیش از حد مجاز عضو دارد');

  const out = [];
  let totalUncompressed = 0;
  for (let i = 0; i < count; i++) {
    if (rd32(u8, cdOff) !== 0x02014b50) break; // corrupted central directory → stop
    const method = rd16(u8, cdOff + 10);
    const compSize = rd32(u8, cdOff + 20);
    const nameLen = rd16(u8, cdOff + 28);
    const extraLen = rd16(u8, cdOff + 30);
    const commentLen = rd16(u8, cdOff + 32);
    const lhOff = rd32(u8, cdOff + 42);
    const name = new TextDecoder().decode(view(u8, cdOff + 46, nameLen));

    // find the local header data offset (local header may carry its own extra)
    let dataOff = 0;
    if (rd32(u8, lhOff) === 0x04034b50) {
      const lhNameLen = rd16(u8, lhOff + 26);
      const lhExtraLen = rd16(u8, lhOff + 28);
      dataOff = lhOff + 30 + lhNameLen + lhExtraLen;
    } else {
      dataOff = lhOff; // non-standard archive — best effort
    }

    if (compSize > 0) {
      totalUncompressed += compSize;
      if (totalUncompressed > MAX_TOTAL_BYTES) throw new Error('حجم محتوای فایل ZIP بیش از حد مجاز است');
      const raw = view(u8, dataOff, compSize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error('روش فشرده‌سازی این ZIP پشتیبانی نمی‌شود (فقط Store/Deflate)');
      out.push({ name, data });
    } else {
      out.push({ name, data: new Uint8Array(0) });
    }
    cdOff += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
