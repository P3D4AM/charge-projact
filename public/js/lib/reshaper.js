// Persian/Arabic text shaping for PDF rendering — pure JS (browser + Worker).
//
// pdf-lib draws glyphs left-to-right with no complex-text shaping, so Arabic/Persian
// strings must be pre-processed:
//   1) normalize Arabic-variant letters to Persian forms (ك→ک، ي→ی، ى→ی، digits)
//   2) map letters to Unicode Arabic Presentation Forms (isolated/initial/medial/final)
//      according to the Arabic joining algorithm (ZWNJ breaks the joining chain)
//   3) apply mandatory Lam-Alef ligatures
//   4) mirror bracket pairs
//   5) reorder for visual LTR drawing: reverse the logical string while keeping
//      digit/Latin runs (which read left-to-right even inside RTL text) intact.
// ZWNJ and Arabic diacritics are removed from the output.

// --- joining classes -------------------------------------------------------
const JT_D = 'D'; // dual-joining (connects both sides)
const JT_R = 'R'; // right-joining (connects to previous only)
const JT_C = 'C'; // join-causing (tatweel)

// char: [isolated, final, initial, medial] — initial/medial only for D
const FORMS = {
  '\u0621': [0xFE80],                      // ء hamza            U
  '\u0622': [0xFE81, 0xFE82],              // آ alef madda       R
  '\u0623': [0xFE83, 0xFE84],              // أ alef hamza above R
  '\u0624': [0xFE85, 0xFE86],              // ؤ waw hamza        R
  '\u0625': [0xFE87, 0xFE88],              // إ alef hamza below R
  '\u0626': [0xFE89, 0xFE8A, 0xFE8B, 0xFE8C], // ئ yeh hamza    D
  '\u0627': [0xFE8D, 0xFE8E],              // ا alef             R
  '\u0628': [0xFE8F, 0xFE90, 0xFE91, 0xFE92], // ب               D
  '\u0629': [0xFE93, 0xFE94],              // ة teh marbuta      R
  '\u062A': [0xFE95, 0xFE96, 0xFE97, 0xFE98], // ت               D
  '\u062B': [0xFE99, 0xFE9A, 0xFE9B, 0xFE9C], // ث               D
  '\u062C': [0xFE9D, 0xFE9E, 0xFE9F, 0xFEA0], // ج               D
  '\u062D': [0xFEA1, 0xFEA2, 0xFEA3, 0xFEA4], // ح               D
  '\u062E': [0xFEA5, 0xFEA6, 0xFEA7, 0xFEA8], // خ               D
  '\u062F': [0xFEA9, 0xFEAA],              // د                  R
  '\u0630': [0xFEAB, 0xFEAC],              // ذ                  R
  '\u0631': [0xFEAD, 0xFEAE],              // ر                  R
  '\u0632': [0xFEAF, 0xFEB0],              // ز                  R
  '\u0633': [0xFEB1, 0xFEB2, 0xFEB3, 0xFEB4], // س               D
  '\u0634': [0xFEB5, 0xFEB6, 0xFEB7, 0xFEB8], // ش               D
  '\u0635': [0xFEB9, 0xFEBA, 0xFEBB, 0xFEBC], // ص               D
  '\u0636': [0xFEBD, 0xFEBE, 0xFEBF, 0xFEC0], // ض               D
  '\u0637': [0xFEC1, 0xFEC2, 0xFEC3, 0xFEC4], // ط               D
  '\u0638': [0xFEC5, 0xFEC6, 0xFEC7, 0xFEC8], // ظ               D
  '\u0639': [0xFEC9, 0xFECA, 0xFECB, 0xFECC], // ع               D
  '\u063A': [0xFECD, 0xFECE, 0xFECF, 0xFED0], // غ               D
  '\u0640': [0x0640],                      // ـ tatweel          C
  '\u0641': [0xFED1, 0xFED2, 0xFED3, 0xFED4], // ف               D
  '\u0642': [0xFED5, 0xFED6, 0xFED7, 0xFED8], // ق               D
  '\u0644': [0xFEDD, 0xFEDE, 0xFEDF, 0xFEE0], // ل               D
  '\u0645': [0xFEE1, 0xFEE2, 0xFEE3, 0xFEE4], // م               D
  '\u0646': [0xFEE5, 0xFEE6, 0xFEE7, 0xFEE8], // ن               D
  '\u0647': [0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC], // ه               D
  '\u0648': [0xFEED, 0xFEEE],              // و                  R
  '\u0649': [0xFEEF, 0xFEF0],              // ى alef maksura     R
  '\u064A': [0xFEF1, 0xFEF2, 0xFEF3, 0xFEF4], // ي arabic yeh    D
  '\u0671': [0xFB50, 0xFB51],              // ٱ alef wasla       R
  '\u0679': [0xFB66, 0xFB67, 0xFB68, 0xFB69], // ٹ TTEH          D
  '\u067B': [0xFB52, 0xFB53, 0xFB54, 0xFB55], // ٻ BEEH          D
  '\u067E': [0xFB56, 0xFB57, 0xFB58, 0xFB59], // پ PEH           D
  '\u0680': [0xFB5A, 0xFB5B, 0xFB5C, 0xFB5D], // ڀ BEHEH         D
  '\u0686': [0xFB7A, 0xFB7B, 0xFB7C, 0xFB7D], // چ TCHEH         D
  '\u0688': [0xFB88, 0xFB89],              // ڊ                  R
  '\u0691': [0xFB8C, 0xFB8D],              // ڑ                  R
  '\u0698': [0xFB8A, 0xFB8B],              // ژ                  R
  '\u06A4': [0xFB6A, 0xFB6B, 0xFB6C, 0xFB6D], // ۋ               D
  '\u06A9': [0xFB8E, 0xFB8F, 0xFB90, 0xFB91], // ک               D
  '\u06AD': [0xFBD3, 0xFBD4, 0xFBD5, 0xFBD6], // ڭ               D
  '\u06AF': [0xFB92, 0xFB93, 0xFB94, 0xFB95], // گ               D
  '\u06C0': [0xFBA4, 0xFBA5],              // ۀ heh w/ yeh       R
  '\u06C1': [0xFBA6, 0xFBA7, 0xFBA8, 0xFBA9], // ہ heh goal      D
  '\u06CC': [0xFBFC, 0xFBFD, 0xFBFE, 0xFBFF], // ی farsi yeh     D
  '\u06D2': [0xFBAE, 0xFBAF]               // ے                  R
};

// Mandatory Lam + Alef ligatures: alef char -> [isolated, final]
const LAM_ALEF = {
  '\u0622': [0xFEF5, 0xFEF6],
  '\u0623': [0xFEF7, 0xFEF8],
  '\u0625': [0xFEF9, 0xFEFA],
  '\u0627': [0xFEFB, 0xFEFC]
};

// transparent (combining) marks — ignored, removed from output
const TRANSPARENT = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7-\u06E8\u06EA-\u06ED]/;

// brackets mirrored when rendering RTL
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{' };

const BREAK = '\u0000'; // internal sentinel produced by ZWNJ

function normalizeChar(c) {
  // Arabic variants -> Persian equivalents for consistent typography
  if (c === '\u0643') return '\u06A9'; // ك -> ک
  if (c === '\u064A') return '\u06CC'; // ي -> ی
  if (c === '\u0649') return '\u06CC'; // ى -> ی
  if (c === '\u06AA') return '\u06A9';
  if (c >= '\u0660' && c <= '\u0669')  // Arabic-Indic digits -> Extended (Persian)
    return String.fromCharCode(0x06F0 + (c.charCodeAt(0) - 0x0660));
  return c;
}

function joinType(c) {
  const f = FORMS[c];
  if (!f) return null;
  if (c === '\u0640') return JT_C;
  return f.length >= 4 ? JT_D : JT_R;
}

const isLetter = c => Boolean(FORMS[c]);
const isDigitOrLatin = c =>
  (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
  (c >= '\u06F0' && c <= '\u06F9');

const CONNECTOR = /[ \u00A0.,:\-\/\u066C\u066B]/;

/**
 * Shapes a logical-order Persian/Arabic string into a visual-order string of
 * presentation-form codepoints, ready for pdf-lib drawText.
 */
export function shapeForPdf(text) {
  const src = String(text ?? '');
  // 1) normalize + drop diacritics + turn ZWNJ into BREAK sentinel
  const chars = [];
  for (const raw of src) {
    if (raw === '\u200C') { chars.push(BREAK); continue; }
    if (TRANSPARENT.test(raw)) continue;
    chars.push(normalizeChar(raw));
  }

  // 2) apply joining forms + lam-alef ligatures (logical order)
  const shaped = [];
  let prevConnects = false; // previous emitted letter connects forward to current
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === BREAK) { prevConnects = false; continue; }

    if (c === '\u0640') { // tatweel
      const nxt = chars[i + 1];
      if (prevConnects || (nxt && nxt !== BREAK && isLetter(nxt))) {
        shaped.push('\u0640');
        prevConnects = true;
      }
      continue;
    }

    const jt = joinType(c);
    if (!jt) {
      shaped.push(MIRROR[c] || c);
      prevConnects = false;
      continue;
    }

    // lam-alef mandatory ligature
    if (c === '\u0644') {
      const nxt = chars[i + 1];
      const lig = nxt && nxt !== BREAK ? LAM_ALEF[nxt] : null;
      if (lig) {
        shaped.push(String.fromCharCode(prevConnects ? lig[1] : lig[0]));
        prevConnects = false; // ligature ends with alef (right-joining)
        i++; // consume the alef
        continue;
      }
    }

    const nxt = chars[i + 1];
    const connectsNext = jt === JT_D && Boolean(nxt) && nxt !== BREAK && isLetter(nxt);
    const forms = FORMS[c];
    let code;
    if (jt === JT_D) {
      code = prevConnects ? (connectsNext ? forms[3] : forms[1])
                          : (connectsNext ? forms[2] : forms[0]);
    } else if (jt === JT_R) {
      code = prevConnects ? forms[1] : forms[0];
    } else { // tatweel reached here only when standalone
      code = forms[0];
    }
    shaped.push(String.fromCharCode(code));
    prevConnects = jt === JT_D && connectsNext;
  }

  // 3) visual reordering: reverse, but keep digit/Latin runs intact (LTR blocks)
  const out = [];
  let i = 0;
  const n = shaped.length;
  while (i < n) {
    const c = shaped[i];
    if (isDigitOrLatin(c)) {
      let j = i;
      let run = '';
      // absorb digits/latin plus connectors that sit between them
      while (j < n) {
        if (isDigitOrLatin(shaped[j])) { run += shaped[j]; j++; continue; }
        if (CONNECTOR.test(shaped[j]) && j + 1 < n && isDigitOrLatin(shaped[j + 1])) {
          run += shaped[j]; j++; continue;
        }
        break;
      }
      out.push(run);
      i = j;
    } else {
      out.push(c);
      i++;
    }
  }
  out.reverse();
  return out.join('');
}

/** Persian digits + thousands separators, e.g. 12500000 -> «۱۲٬۵۰۰٬۰۰۰» */
export function faMoney(n) {
  const v = Math.round(Number(n) || 0);
  const neg = v < 0;
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u066C')
    .replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
  return (neg ? '\u2212' : '') + s;
}

/** Any number -> Persian digits */
export function faDigits(v) {
  return String(v ?? '').replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
}
