// v2.20.1 — schema drift reconcile (تطبیق ستون‌های جاافتاده قبل از اعمال schema.sql)
//
// مشکل: «CREATE TABLE IF NOT EXISTS» روی دیتابیس‌های موجود هیچ‌وقت ستون جدید اضافه
// نمی‌کند. ستون‌های بعدی (v7 به بعد) با self-migration داخل Worker در اولین اجرا
// اضافه می‌شوند؛ اما اگر schema.sql روی یکی از این ستون‌ها ایندکس داشته باشد
// (مثل idx_bot_messages_dir روی direction در v2.19.0)، گام ۳ دیپلوی با
// «no such column: direction» می‌میرد و Worker هیچ‌وقت deploy نمی‌شود تا
// self-migration اجرا شود — بن‌بست.
//
// راه‌حل: قبل از اعمال schema.sql، ستون‌های موردانتظار از خود schema.sql خوانده
// می‌شود، ستون‌های واقعی دیتابیس ریموت probe می‌شود و برای هر ستون جاافتاده‌ای که
// جدولش در دیتابیس موجود است، «ALTER TABLE … ADD COLUMN» اجرا می‌شود.
// این ماژول عمداً خالص است (بدون شبکه/فایل) تا هم در deploy.mjs و هم در تست‌ها
// استفاده شود.

const CONSTRAINT_KEYWORDS = new Set(['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT']);

// حذف کامنت‌های خطی «--» با احترام به رشته‌های داخل کوتیشن (DEFAULT 'in' و…)
export function stripLineComments(text) {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" ) {
      inQuote = !inQuote;
      out += ch;
      continue;
    }
    if (!inQuote && ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

// تجزیهٔ schema.sql → Map<جدول, آرایهٔ ستون‌ها>
// هر ستون: { name, type, pk, notNull, unique, references, defaultLit }
// defaultLit فقط برای literalهای ثابت (رشته/عدد) مقدار دارد؛ CURRENT_TIMESTAMP و
// امثال او عمداً ignore می‌شوند چون در ADD COLUMN مجاز نیستند.
export function parseSchemaTables(sqlText) {
  const clean = stripLineComments(String(sqlText || ''));
  const tables = new Map();
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_]\w*)["'`]?\s*\(/gi;
  let m;
  while ((m = createRe.exec(clean)) !== null) {
    const name = m[1];
    // بدنه تا بسته‌شدن پرانتز (عمق‌سنجی + احترام به کوتیشن)
    let depth = 1;
    let i = createRe.lastIndex;
    let inQuote = false;
    const start = i;
    for (; i < clean.length && depth > 0; i++) {
      const ch = clean[i];
      if (ch === "'") inQuote = !inQuote;
      else if (!inQuote && ch === '(') depth++;
      else if (!inQuote && ch === ')') depth--;
    }
    if (depth !== 0) break; // اسکیما ناقص — همان‌قدر که خوانده شد کافی است
    const body = clean.slice(start, i - 1);
    createRe.lastIndex = i;

    // برش بدنه روی کاماهای بیرون از پرانتز/کوتیشن
    const parts = [];
    let cur = '';
    depth = 0;
    inQuote = false;
    for (const ch of body) {
      if (ch === "'") inQuote = !inQuote;
      else if (!inQuote && ch === '(') depth++;
      else if (!inQuote && ch === ')') depth--;
      if (ch === ',' && depth === 0 && !inQuote) { parts.push(cur); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) parts.push(cur);

    const cols = [];
    for (const raw of parts) {
      const part = raw.trim();
      if (!part) continue;
      const idm = part.match(/^["'`]?([A-Za-z_]\w*)["'`]?/);
      if (!idm) continue;
      if (CONSTRAINT_KEYWORDS.has(idm[1].toUpperCase())) continue; // محدودیت سطح جدول
      const decl = part.slice(idm[0].length).trim();
      const defM = decl.match(/\bDEFAULT\s+('(?:[^']|'')*'|[+-]?\d+(?:\.\d+)?)\s*$/i);
      const wordDefault = /\bDEFAULT\s+[A-Za-z_]\w*\s*$/i.test(decl); // CURRENT_TIMESTAMP و…
      const refIdx = decl.search(/\bREFERENCES\b/i);
      cols.push({
        name: idm[1],
        type: (decl.match(/^([A-Za-z]\w*)/) || [])[1] || 'TEXT',
        pk: /\bPRIMARY\s+KEY\b/i.test(part),
        notNull: /\bNOT\s+NULL\b/i.test(part),
        unique: /\bUNIQUE\b/i.test(part),
        references: refIdx >= 0,
        referencesTail: refIdx >= 0 ? decl.slice(refIdx).trim() : '',
        defaultLit: wordDefault ? null : (defM ? defM[1] : null)
      });
    }
    tables.set(name, cols);
  }
  return tables;
}

// ساخت یک دستورِ batch برای خواندن ستون‌های همهٔ جدول‌های موردانتظار در «یک» رفت‌وبرگشت.
// pragma_table_info روی جدولِ ناموجود خطا نمی‌دهد — فقط نتیجهٔ خالی برمی‌گرداند.
export function buildProbeCommand(tableNames) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return [...tableNames]
    .map((t) => `SELECT ${q(t)} AS tbl, name AS col FROM pragma_table_info(${q(t)})`)
    .join('; ');
}

// خروجی JSON چندبلوکی wrangler d1 execute → ردیف‌های {tbl, col}
export function extractProbeRows(parsed) {
  let blocks = null;
  if (Array.isArray(parsed)) blocks = parsed;
  else if (parsed && Array.isArray(parsed.result)) blocks = parsed.result;
  else if (parsed && typeof parsed === 'object') blocks = [parsed];
  const rows = [];
  if (!blocks) return rows;
  for (const b of blocks) {
    const rs = b && Array.isArray(b.results) ? b.results : (Array.isArray(b) ? b : null);
    if (!rs) continue;
    for (const r of rs) {
      if (r && typeof r === 'object' && r.tbl && r.col) rows.push({ tbl: String(r.tbl), col: String(r.col) });
    }
  }
  return rows;
}

// ساخت DDL «ALTER TABLE … ADD COLUMN …» با احترام به محدودیت‌های SQLite:
//  - ستون PK جدول موجود → null (نمی‌شود/لازم نیست اضافه شود)
//  - NOT NULL فقط با DEFAULT ثابت مجاز است؛ وگرنه ستون nullable اضافه می‌شود (یادداشت)
//  - UNIQUE در ADD COLUMN مجاز نیست → حذف (یادداشت)
//  - REFERENCES هنگامی که foreign_keys روشن است باید default=NULL داشته باشد →
//    NOT NULL/DEFAULT از دست می‌روند و فقط عبارت REFERENCES حفظ می‌شود
export function buildAddColumnDdl(table, col) {
  if (!col || col.pk) return null;
  const notes = [];
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  let seg = col.type || 'TEXT';
  const hasRef = !!col.references;
  if (hasRef) {
    notes.push('NOT NULL/DEFAULT dropped: REFERENCES requires a NULL default');
  } else if (col.notNull && col.defaultLit != null) {
    seg += ` NOT NULL DEFAULT ${col.defaultLit}`;
  } else if (col.notNull) {
    notes.push('NOT NULL dropped: no constant DEFAULT in schema');
  }
  if (col.unique) notes.push('UNIQUE dropped: not allowed in ADD COLUMN');
  if (hasRef && typeof col.referencesTail === 'string' && col.referencesTail) seg += ` ${col.referencesTail}`;
  return { ddl: `ALTER TABLE ${q(table)} ADD COLUMN ${q(col.name)} ${seg}`, notes };
}

// مقایسهٔ موردانتظار (schema.sql) با واقعی (ردیف‌های probe) → ستون‌های جاافتاده
// جدولِ ناموجود در دیتابیس کلاً رد می‌شود (schema.sql خودش می‌سازد).
export function diffMissingColumns(expected, probeRows) {
  const existing = new Map();
  for (const r of probeRows) {
    if (!existing.has(r.tbl)) existing.set(r.tbl, new Set());
    existing.get(r.tbl).add(r.col);
  }
  const missing = [];
  for (const [table, cols] of expected) {
    const actual = existing.get(table);
    if (!actual || actual.size === 0) continue; // جدول هنوز وجود ندارد
    for (const col of cols) {
      if (actual.has(col.name)) continue;
      const built = buildAddColumnDdl(table, col);
      if (!built) continue;
      missing.push({ table, name: col.name, ddl: built.ddl, notes: built.notes });
    }
  }
  return missing;
}
