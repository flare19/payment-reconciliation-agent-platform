/**
 * Date parsing — three deliberately different source formats to one IST business
 * date plus a UTC instant (schema.md §0).
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE:
 *
 * 1. THE FORMAT IS DECLARED, NEVER INFERRED. The ledger emits MM/DD/YYYY and the
 *    bank emits DD-MM-YYYY. `03/04/2026` is 3 April in one and 4 March in the
 *    other, and NOTHING in the string says which. A parser that guesses is right
 *    about 70% of the time — the generator only emits days ≥13 on ~30% of rows
 *    precisely so inference cannot cheat (schema.md §2.3) — and every wrong guess
 *    is a silently misdated record that quietly fails or, worse, quietly succeeds
 *    against the wrong counterpart.
 *
 * 2. NEVER `new Date(someString)`. Parsing of non-ISO strings is
 *    implementation-defined, and for ISO date-only strings V8 assumes UTC while
 *    for date-time strings without an offset it assumes LOCAL time. That single
 *    inconsistency would put a run's business dates one day apart depending on
 *    where it ran. Every parse below is an explicit regex plus `Date.UTC`.
 *
 * IST is UTC+05:30 with no daylight saving — India has never observed DST in the
 * modern era — so a fixed offset is exactly correct and no timezone database is
 * required. That is a real simplification, not a shortcut.
 */

export const IST_OFFSET_MINUTES = 330;

export const DateWarning = {
  MISSING: 'DATE_MISSING',
  ASSUMED_IST: 'DATE_ASSUMED_IST',
  CROSSED_MIDNIGHT_UTC: 'DATE_CROSSED_UTC_MIDNIGHT',
} as const;

export type DateWarningCode = (typeof DateWarning)[keyof typeof DateWarning];

/** The formats the three sources emit. Passed explicitly by each parser. */
export type SourceDateFormat =
  | 'YYYY-MM-DD HH:MM:SS'   // gateway, IST wall time, no offset marker
  | 'DD-MM-YYYY'            // bank value_date / posting_date
  | 'MM/DD/YYYY';           // ledger entry_date — US order, deliberately

export interface ParsedDate {
  /** IST calendar date, `YYYY-MM-DD`. The business day the record belongs to. */
  businessDate: string;
  /** Full instant as an ISO-8601 UTC string, or null when the source has no time. */
  timestampUtc: string | null;
  warnings: DateWarningCode[];
}

export type DateParseResult =
  | { ok: true; value: ParsedDate | null; warnings: DateWarningCode[] }
  | { ok: false; error: string };

const PATTERNS: Record<SourceDateFormat, RegExp> = {
  'YYYY-MM-DD HH:MM:SS': /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  'DD-MM-YYYY': /^(\d{2})-(\d{2})-(\d{4})$/,
  'MM/DD/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})$/,
};

/** Rejects 2026-02-30 and 2026-13-01. Date.UTC happily rolls those over. */
function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

export function parseSourceDate(
  raw: string | null | undefined,
  format: SourceDateFormat,
): DateParseResult {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return { ok: true, value: null, warnings: [DateWarning.MISSING] };
  }

  const s = raw.trim();
  const match = PATTERNS[format].exec(s);
  if (!match) return { ok: false, error: `Date "${raw}" does not match declared format ${format}` };

  let year: number, month: number, day: number;
  let hour: number | null = null, minute = 0, second = 0;

  if (format === 'YYYY-MM-DD HH:MM:SS') {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
    if (match[4] !== undefined) {
      hour = Number(match[4]); minute = Number(match[5]); second = Number(match[6] ?? '0');
    }
  } else if (format === 'DD-MM-YYYY') {
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
  } else {
    // MM/DD/YYYY — month FIRST. Declared by the caller, never sniffed from the value.
    month = Number(match[1]); day = Number(match[2]); year = Number(match[3]);
  }

  if (!isRealDate(year, month, day)) {
    return { ok: false, error: `Date "${raw}" is not a real calendar date` };
  }
  if (hour !== null && (hour > 23 || minute > 59 || second > 59)) {
    return { ok: false, error: `Time in "${raw}" is out of range` };
  }

  const businessDate = `${year}-${pad(month)}-${pad(day)}`;
  const warnings: DateWarningCode[] = [];

  if (hour === null) {
    // Date-granularity source (bank, ledger). No instant to record — inventing a
    // midnight timestamp would be fabricating precision the source never had.
    return { ok: true, value: { businessDate, timestampUtc: null, warnings }, warnings };
  }

  // The wall time IS IST; the source carries no offset marker, so this assumption
  // is recorded on the record rather than left implicit.
  warnings.push(DateWarning.ASSUMED_IST);

  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - IST_OFFSET_MINUTES * 60_000;
  const instant = new Date(utcMs);

  // TZ_MIDNIGHT_DRIFT: a payment captured at 00:20 IST on the 15th is 18:50 UTC on
  // the 14th, and a bank booking in UTC files it against the 14th. The business
  // date stays the 15th — that is the whole point of storing both — but the record
  // is flagged so a one-day gap later reads as a known artifact rather than a
  // mystery. This is also why every date window carries a -1 (ADR-009).
  if (instant.getUTCDate() !== day) warnings.push(DateWarning.CROSSED_MIDNIGHT_UTC);

  return { ok: true, value: { businessDate, timestampUtc: instant.toISOString(), warnings }, warnings };
}

/** IST business date for a UTC instant. The inverse of the conversion above. */
export function businessDateFromInstant(instant: Date): string {
  const ist = new Date(instant.getTime() + IST_OFFSET_MINUTES * 60_000);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

/**
 * Signed whole-day difference, `b - a`, over IST business dates.
 *
 * Pure calendar arithmetic on `YYYY-MM-DD` strings — no Date objects in the
 * comparison path, so no local-timezone influence and no DST-style discontinuity.
 * Every date-window test in the matching engine goes through this.
 */
export function dayDelta(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  const MS_PER_DAY = 86_400_000;
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / MS_PER_DAY);
}

/** Add whole days to a business date, staying in calendar space. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Is `date` inside `[anchor + window[0], anchor + window[1]]`, inclusive? */
export function withinWindow(
  anchorDate: string, candidateDate: string, window: readonly [number, number],
): boolean {
  const delta = dayDelta(anchorDate, candidateDate);
  return delta >= window[0] && delta <= window[1];
}
