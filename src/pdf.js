// Worker-side PDF adapter: injects pdf-lib/fontkit (bundled by wrangler) and the
// Vazirmatn fonts into the shared pdf-core builders.
//
// v2.14.0 — fonts are EMBEDDED in the bundle (src/fonts.js, base64) instead of
// being fetched from the static assets. This permanently fixes the production
// failure «فونت‌های PDF در assets یافت نشدند» that happened when a deployment
// (GitHub Actions, manual wrangler, partial upload) shipped without public/fonts.
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { VAZIR_REGULAR_B64, VAZIR_BOLD_B64 } from './fonts.js';
import {
  buildStatementPdf as coreStatement,
  buildYearReportPdf as coreYearReport,
  buildMonthlyReportPdf as coreMonthlyReport,
  buildPerformanceReportPdf as corePerformanceReport,
  buildTasksReportPdf as coreTasksReport
} from '../public/js/lib/pdf-core.js';
import * as jalali from '../public/js/jalali.js';

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

let fontCache = null;

function loadFonts() {
  if (!fontCache) {
    fontCache = {
      regular: b64ToArrayBuffer(VAZIR_REGULAR_B64),
      bold: b64ToArrayBuffer(VAZIR_BOLD_B64)
    };
  }
  return fontCache;
}

const lib = { PDFDocument, rgb };

export async function buildStatementPdf(env, data) {
  const fonts = loadFonts();
  return coreStatement({ lib, fontkit, fonts, data: { ...data, jalali } });
}

export async function buildYearReportPdf(env, data) {
  const fonts = loadFonts();
  return coreYearReport({ lib, fontkit, fonts, data: { ...data, jalali } });
}

export async function buildMonthlyReportPdf(env, data) {
  const fonts = loadFonts();
  return coreMonthlyReport({ lib, fontkit, fonts, data: { ...data, jalali } });
}

export async function buildPerformanceReportPdf(env, data) {
  const fonts = loadFonts();
  return corePerformanceReport({ lib, fontkit, fonts, data: { ...data, jalali } });
}

// v2.15.0 — گزارش «کارهای مدیر ساختمان» (برای ساکنین هم)
export async function buildTasksReportPdf(env, data) {
  const fonts = loadFonts();
  return coreTasksReport({ lib, fontkit, fonts, data: { ...data, jalali } });
}
