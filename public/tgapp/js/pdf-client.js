// Browser-side PDF generation for the demo/preview mode (no server).
// Loads pdf-lib + fontkit UMD bundles from CDN, then reuses the SAME layout
// core (lib/pdf-core.js) the Worker uses — so the demo PDF matches production.
import { shapeForPdf, faMoney, faDigits } from './lib/reshaper.js';
import { periodLabel, J_MONTHS, toJalaaliFromParts, todayLocalJalaali } from './jalali.js';
import { mockFetch } from './mock.js';

let libPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('load failed: ' + src));
    document.head.appendChild(s);
  });
}

async function getLib() {
  if (!libPromise) {
    libPromise = (async () => {
      await loadScript('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js');
      if (!window.PDFLib || !window.fontkit) throw new Error('کتابخانه PDF بارگذاری نشد');
      return {
        PDFDocument: window.PDFLib.PDFDocument,
        rgb: window.PDFLib.rgb,
        fontkit: window.fontkit
      };
    })();
  }
  return libPromise;
}

async function getFonts() {
  const [regular, bold] = await Promise.all([
    fetch('fonts/Vazirmatn-Regular.ttf').then(r => r.arrayBuffer()),
    fetch('fonts/Vazirmatn-Bold.ttf').then(r => r.arrayBuffer())
  ]);
  return { regular, bold };
}

function tehranParts(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(ts * 1000));
  const get = t => Number((parts.find(x => x.type === t) || {}).value || 0);
  return { gy: get('year'), gm: get('month'), gd: get('day') };
}

export async function downloadMockPdf(kind, { unitId, jy } = {}) {
  const lib = await getLib();
  const fonts = await getFonts();
  const jalali = { J_MONTHS, toJalaaliFromParts, todayLocalJalaali };
  const generated_at = Math.floor(Date.now() / 1000);

  // pull the same data the server endpoints would return
  const settingsRes = await mockFetch('/settings/public', 'GET', {});
  const s = settingsRes.settings || {};

  const { buildStatementPdf, buildYearReportPdf } = await import('./lib/pdf-core.js');

  let bytes;
  if (kind === 'report') {
    const rep = await mockFetch('/reports/year?jy=' + (jy || ''), 'GET', {});
    bytes = await buildYearReportPdf({
      lib, fontkit: lib.fontkit, fonts,
      data: {
        building_name: s.building_name, address: s.address,
        jy: rep.jy, series: rep.series, by_unit: rep.by_unit,
        generated_at, jalali
      }
    });
  } else {
    const sum = await mockFetch('/my/summary', 'GET', {});
    let unit = sum.unit;
    let debts = sum.debts || [];
    // yearly statement for the resident's own unit (گزارش سالانه)
    if (jy) debts = debts.filter(d => String(d.period || '').startsWith(jy + '-'));
    let totals = jy
      ? {
          issued: debts.reduce((a, d) => a + d.amount, 0),
          paid: debts.reduce((a, d) => a + d.paid_amount, 0)
        }
      : sum.totals;
    if (jy) totals.remaining = Math.max(0, totals.issued - totals.paid);
    // manager downloading a specific unit's statement
    if (unitId && (!unit || unit.id !== unitId)) {
      const units = (await mockFetch('/units', 'GET', {})).units || [];
      unit = units.find(u => u.id === unitId) || unit;
      let udebts = (await mockFetch('/debts?unit_id=' + unitId, 'GET', {})).debts || [];
      if (jy) udebts = udebts.filter(d => String(d.period || '').startsWith(jy + '-'));
      debts = udebts;
      totals = {
        issued: debts.reduce((a, d) => a + d.amount, 0),
        paid: debts.reduce((a, d) => a + d.paid_amount, 0)
      };
      totals.remaining = totals.issued - totals.paid;
    }
    bytes = await buildStatementPdf({
      lib, fontkit: lib.fontkit, fonts,
      data: {
        building_name: s.building_name, address: s.address,
        unit, debts, totals,
        settings: { bank_card: s.bank_card, bank_owner: s.bank_owner, phone: s.phone },
        generated_at, jalali
      }
    });
  }

  void shapeForPdf; void faMoney; void faDigits; void periodLabel; void tehranParts;

  const blob = new Blob([bytes], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = kind === 'report' ? `report-${jy || ''}.pdf` : (jy ? `statement-${jy}.pdf` : 'statement.pdf');
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
