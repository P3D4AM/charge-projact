// Jalali utilities — single source of truth lives in the browser assets
// (public/js/jalali.js) so the same module is used by the Worker (bundled by
// wrangler), Node tests and the frontend without duplication.
export {
  jalCal, j2d, d2j, toJalaali, toGregorian, isLeapJalaali, jalaaliMonthLength,
  J_MONTHS, FA_DIGITS, faNum, tehranToday, toJalaaliFromParts, currentPeriod,
  localPeriod, todayLocalJalaali, isPeriod, isJalaliYear, periodLabel, addPeriods,
  FA_WEEKDAYS, tehranParts, formatJalaliDateTime, tehranDayStartSec
} from '../public/js/jalali.js';
