/**
 * Money parsing — messy rupee strings to integer paise (ADR-006).
 *
 * A parser bug here is INVISIBLE: it produces a number, just the wrong one, and
 * every downstream figure stays plausible. There is no stack trace and no failing
 * request — only a match rate that is quietly wrong. That is why this file does
 * string arithmetic instead of the obvious thing.
 *
 * THE FLOAT TRAP, stated once so nobody "simplifies" this back:
 *
 *     Math.round(parseFloat(raw) * 100)     // WRONG
 *
 * fails three ways at once.
 *   1. `parseFloat("1,23,456.50")` is `1`. parseFloat stops at the first comma
 *      and returns a confident, catastrophically wrong answer.
 *   2. Binary floats cannot hold decimal fractions exactly. `1.005 * 100` is
 *      `100.49999999999999`, so round-half-up yields 100 paise where 101 is
 *      correct. The error appears on a handful of rows and nowhere else.
 *   3. It silently accepts `"1e3"`, `"Infinity"` and `"1.2.3"`.
 *
 * So: normalise the string, validate it strictly, then split on the decimal point
 * and do integer arithmetic on the digits. No float ever holds a monetary value.
 */

export const MoneyWarning = {
  MISSING: 'AMOUNT_MISSING',
  HAD_CURRENCY_SYMBOL: 'AMOUNT_HAD_CURRENCY_SYMBOL',
  ACCOUNTING_NEGATIVE: 'AMOUNT_ACCOUNTING_NEGATIVE',
  ROUNDED_TO_PAISE: 'AMOUNT_ROUNDED_TO_PAISE',
  NO_FRACTION: 'AMOUNT_NO_FRACTIONAL_PART',
} as const;

export type MoneyWarningCode = (typeof MoneyWarning)[keyof typeof MoneyWarning];

export type MoneyParseResult =
  /** `paise: null` means the source left the field blank — a nullable column, not an error. */
  | { ok: true; paise: number | null; warnings: MoneyWarningCode[] }
  /** The field had content that is not a number. The ROW is rejected (ADR-046), not defaulted to 0. */
  | { ok: false; error: string };

/** Currency markers seen in Indian payment exports. Stripped, and flagged when present. */
const CURRENCY_MARKERS = /(?:₹|\bINR\b|\bRs\.?|\bRUPEES?\b)/gi;

/**
 * After cleaning, this is the ONLY shape accepted. Anything else is a rejected row.
 *
 * DELIBERATELY UNSIGNED. Sign is consumed above this check, so allowing `-` here
 * lets a second one through: `"--5"` loses one minus to the sign handler, passes
 * a signed pattern as `"-5"`, and then has its negative applied a second time —
 * returning +500 paise from an input that is not a number at all. Caught by
 * tests/unit/money.test.ts, which is what that test exists for.
 */
const STRICT_DECIMAL = /^\d+(?:\.\d*)?$/;

/**
 * Parse a rupee string into integer paise.
 *
 * Handles: `"1,234.50"`, `"₹1234.5"`, `"1,23,456.50"` (Indian lakh grouping),
 * `" 1234.50 "`, `"(1,234.50)"` (accounting negative), `"Rs. 500"`, `""`.
 *
 * Rounding is HALF-UP ON MAGNITUDE (away from zero), the ordinary financial
 * convention: `1234.567 → 123457`, `-1234.567 → -123457`. Symmetric, so a debit
 * and its matching credit round identically — which matters, because an
 * asymmetric rule would make a reversal fail to reconcile against its original
 * by exactly one paisa.
 */
export function parseMoney(raw: string | null | undefined): MoneyParseResult {
  if (raw === null || raw === undefined) {
    return { ok: true, paise: null, warnings: [MoneyWarning.MISSING] };
  }

  const warnings: MoneyWarningCode[] = [];
  let s = raw.trim();
  if (s === '') return { ok: true, paise: null, warnings: [MoneyWarning.MISSING] };

  if (CURRENCY_MARKERS.test(s)) {
    warnings.push(MoneyWarning.HAD_CURRENCY_SYMBOL);
    // `.test` on a /g regex advances lastIndex; reset before replacing.
    CURRENCY_MARKERS.lastIndex = 0;
    s = s.replace(CURRENCY_MARKERS, '');
  }

  // Accounting negatives: (1,234.50). Detected before separator stripping so a
  // stray paren cannot survive into the strict check.
  let negative = false;
  const parenthesised = /^\(\s*(.*?)\s*\)$/.exec(s);
  if (parenthesised) {
    negative = true;
    s = parenthesised[1]!;
    warnings.push(MoneyWarning.ACCOUNTING_NEGATIVE);
  }

  // Strip ALL group separators rather than validating grouping. Indian grouping
  // is 1,23,456.50 — two-digit groups above the hundreds — so any rule expecting
  // groups of three would reject or mis-read a perfectly ordinary Indian amount.
  s = s.replace(/[,\s  ]/g, '');

  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) {
    if (negative) return { ok: false, error: `Ambiguous sign in amount "${raw}"` };
    negative = true;
    s = s.slice(1);
  }

  if (s === '') return { ok: true, paise: null, warnings: [MoneyWarning.MISSING] };
  if (!STRICT_DECIMAL.test(s)) {
    return { ok: false, error: `Unparseable amount "${raw}"` };
  }

  const dot = s.indexOf('.');
  const wholePart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? '' : s.slice(dot + 1);

  if (dot === -1) warnings.push(MoneyWarning.NO_FRACTION);

  // Integer arithmetic from here down. `wholePart` is digits only (guaranteed by
  // STRICT_DECIMAL), so Number() is exact up to Number.MAX_SAFE_INTEGER.
  const rupees = Number(wholePart);
  if (!Number.isSafeInteger(rupees)) {
    return { ok: false, error: `Amount "${raw}" is too large to represent exactly` };
  }

  const paiseDigits = (fracPart + '00').slice(0, 2);        // pad, never truncate meaning
  let paiseFraction = Number(paiseDigits);

  // Half-up on magnitude: the third fractional digit alone decides, because any
  // sequence beginning 0-4 is strictly below half and any beginning 5-9 is at or
  // above it. `0.4999` rounds up to 50 paise because its third digit is 9.
  const thirdDigit = fracPart.length > 2 ? Number(fracPart[2]) : 0;
  if (fracPart.length > 2) {
    warnings.push(MoneyWarning.ROUNDED_TO_PAISE);
    if (thirdDigit >= 5) paiseFraction += 1;
  }

  const magnitude = rupees * 100 + paiseFraction;
  if (!Number.isSafeInteger(magnitude)) {
    return { ok: false, error: `Amount "${raw}" exceeds the safe integer range in paise` };
  }

  return { ok: true, paise: negative ? -magnitude : magnitude, warnings };
}

/**
 * Format paise for display. THE ONLY money formatter in the system.
 *
 * The API sends `amountDisplay` alongside `amountPaise` so the frontend never
 * formats currency itself (api-contract §0) — one formatter server-side means the
 * dashboard and the API cannot disagree about a number, which in a reconciliation
 * product would be an embarrassing bug to have on screen.
 *
 * Indian digit grouping: last three digits, then twos. ₹12,34,567.89.
 */
export function formatPaise(paise: number): string {
  const negative = paise < 0;
  const magnitude = Math.abs(paise);
  const rupees = Math.trunc(magnitude / 100);
  const fraction = magnitude % 100;

  const digits = String(rupees);
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const lastThree = digits.slice(-3);
    const rest = digits.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree;
  }

  return `${negative ? '-' : ''}₹${grouped}.${String(fraction).padStart(2, '0')}`;
}
