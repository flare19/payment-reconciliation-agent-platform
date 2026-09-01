/**
 * Every formatter the frontend is allowed to have — and money is not among them.
 *
 * The API sends `amountDisplay` pre-formatted (api-contract §0, ui-spec §9) so
 * that one formatter, server-side, decides what a rupee figure looks like. A
 * second formatter here would eventually disagree with it, and a reconciliation
 * product whose own two screens disagree about a number has lost the argument
 * before anyone reads the match rate.
 *
 * Counts, percentages and dates are safe to format client-side because they are
 * derived from integers the API already sent, not re-derived from paise.
 *
 * Locale and time zone are PINNED, never taken from the viewer. `Intl` reading
 * the runtime's zone would render one instant differently on the server and in
 * the browser, which React reports as a hydration mismatch — and would also mean
 * a judge in another time zone sees different business dates than the ones the
 * run was computed against (`runs.reference_date`, ADR-039).
 */

const LOCALE = 'en-IN';
const ZONE = 'Asia/Kolkata';

const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });

const percent2 = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const decimal4 = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 4, maximumFractionDigits: 4,
});

const decimal1 = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1, maximumFractionDigits: 1,
});

const businessDate = new Intl.DateTimeFormat(LOCALE, {
  timeZone: ZONE, year: 'numeric', month: 'short', day: '2-digit',
});

const instant = new Intl.DateTimeFormat(LOCALE, {
  timeZone: ZONE, year: 'numeric', month: 'short', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

export const count = (n: number) => integer.format(n);

/** `65.22` → `"65.22%"`. Two places, always — a match rate that renders as `65%` one day and `65.2%` the next reads as two different numbers. */
export const pct = (n: number) => `${percent2.format(n)}%`;

/** Precision and recall, at the width the scorer reports them. */
export const ratio4 = (n: number) => decimal4.format(n);

export const oneDp = (n: number) => decimal1.format(n);

/** A `"2026-08-21"` business date, in IST. */
export const day = (isoDate: string) => businessDate.format(new Date(`${isoDate}T00:00:00+05:30`));

/** An instant, in IST. */
export const at = (iso: string) => `${instant.format(new Date(iso))} IST`;

/** `SCREAMING_SNAKE` taxonomy value → `Screaming snake`, for prose contexts. */
export const humanizeCategory = (key: string) =>
  key.charAt(0) + key.slice(1).toLowerCase().replace(/_/g, ' ');

/**
 * Milliseconds, at a width that stays comparable down a column.
 *
 * The space is non-breaking: a value and its unit are one token, and `33,050`
 * left at the end of a line with `ms` starting the next one is a number the
 * reader has to reassemble.
 */
export const ms = (n: number) => `${integer.format(n)}\u00A0ms`;

const plurals = new Intl.PluralRules(LOCALE);

/**
 * `1 call failed`, not `1 calls failed`.
 *
 * Worth a helper rather than a ternary at each call site: a broken plural is
 * the cheapest possible way to make a page that is arguing for rigour look like
 * nobody read it.
 */
export const plural = (n: number, one: string, many: string) =>
  plurals.select(n) === 'one' ? one : many;
