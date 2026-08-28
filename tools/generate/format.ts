/**
 * Formatting — canonical, typed values to the messy strings the CSV files carry
 * (schema.md §2.1-2.3).
 *
 * This is the INVERSE of `apps/api/src/services/ingestion/{money,dates}.ts`,
 * which is why it lives here rather than importing anything from there for the
 * formatting itself: those files PARSE messy strings into typed values, and there
 * is no "format a date as DD-MM-YYYY" concern anywhere in the engine to reuse —
 * the engine never writes a source file. `addDays`/`dayDelta` (calendar
 * arithmetic) ARE reused from `ingestion/dates.ts` wherever this file needs them,
 * because that IS decision logic the engine owns.
 *
 * Every formatter here must round-trip through the engine's real parser
 * (`money.ts`/`dates.ts`) without a warning that would change `anchor_strength`
 * or reject the row — verified in format.test.ts by calling those parsers
 * directly, not by re-deriving what "valid" means.
 */

import type { Rng } from './prng.js';

// ─── money ────────────────────────────────────────────────────────────────────

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** `paise` as `"<rupees>.<fraction>"`, exact, no grouping, no symbol (§2.2, §2.3's plain format). */
export function formatPlainRupees(paise: number): string {
  const rupees = Math.trunc(paise / 100);
  const fraction = String(Math.abs(paise) % 100).padStart(2, '0');
  return `${rupees}.${fraction}`;
}

/** Indian digit grouping — last three, then twos: `12,34,567.50`. */
function groupIndian(rupeesDigits: string): string {
  if (rupeesDigits.length <= 3) return rupeesDigits;
  const lastThree = rupeesDigits.slice(-3);
  const rest = rupeesDigits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}`;
}

/**
 * The gateway `amount`/`fee`/`tax`/`net_amount` messiness §2.1 names explicitly:
 * `"1,234.50"`, `"₹1234.5"`, `"1234.50"`. Ledger and bank amounts stay plain
 * (`formatPlainRupees`) — nothing in §2.2/§2.3 calls for variety there, and adding
 * it would be inventing messiness the spec never asked for.
 *
 * The `₹1234.5` variant is DELIBERATELY one fractional digit sometimes — real
 * exports round to the rupee more often than they carry two decimals, and
 * `money.ts` already has to handle a missing second digit (it pads, never
 * truncates meaning), so leaving that path untested would be an easy invariant to
 * silently stop exercising.
 */
export function formatMessyRupees(rng: Rng, paise: number): string {
  const negative = paise < 0;
  const magnitude = Math.abs(paise);
  const rupees = Math.trunc(magnitude / 100);
  const fraction = magnitude % 100;
  const sign = negative ? '-' : '';

  const style = rng.weightedPick([
    { value: 'plain', weight: 40 },
    { value: 'symbol', weight: 25 },
    { value: 'grouped', weight: 35 },
  ] as const);

  switch (style) {
    case 'plain':
      return `${sign}${rupees}.${String(fraction).padStart(2, '0')}`;
    case 'symbol': {
      // One fractional digit when it divides evenly by ten — "₹1234.5", not
      // "₹1234.50" — money.ts pads a short fraction rather than rejecting it.
      const frac = fraction % 10 === 0 ? String(fraction / 10) : String(fraction).padStart(2, '0');
      return `${sign}₹${rupees}.${frac}`;
    }
    case 'grouped':
      return `${sign}${groupIndian(String(rupees))}.${String(fraction).padStart(2, '0')}`;
  }
}

// ─── dates ────────────────────────────────────────────────────────────────────

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/**
 * `YYYY-MM-DD HH:MM:SS`, IST wall time, no offset marker — gateway
 * `created_at`/`captured_at` (§2.1).
 *
 * VALIDATES ITS INPUT, because the alternative is silent bad data. A caller doing
 * naive time arithmetic (`second + 2` with no carry) produces `19:47:61`, which
 * `parseSourceDate` correctly REJECTS — and a rejected row is dropped from the
 * matching population entirely (ADR-046), so the event behind it becomes a false
 * exception and the measured accuracy is wrong for a reason nothing downstream
 * can see. The formatter must not be able to emit something the parser refuses.
 */
export function formatGatewayTimestamp(businessDate: string, hour: number, minute: number, second: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23
    || !Number.isInteger(minute) || minute < 0 || minute > 59
    || !Number.isInteger(second) || second < 0 || second > 59) {
    throw new Error(
      `formatGatewayTimestamp: ${hour}:${minute}:${second} is not a valid wall-clock time. ` +
      `parseSourceDate would reject it and the row would be dropped from the population.`);
  }
  return `${businessDate} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/** Wall-clock time plus whole seconds, carrying into minutes and hours, clamped to the same day. */
export function plusSeconds(
  time: { hour: number; minute: number; second: number }, delta: number,
): { hour: number; minute: number; second: number } {
  const END_OF_DAY = 23 * 3600 + 59 * 60 + 59;
  const total = Math.min(END_OF_DAY, Math.max(0, time.hour * 3600 + time.minute * 60 + time.second + delta));
  return { hour: Math.floor(total / 3600), minute: Math.floor((total % 3600) / 60), second: total % 60 };
}

/** `DD-MM-YYYY` — bank `value_date`/`posting_date` (§2.2). */
export function formatDDMMYYYY(businessDate: string): string {
  const [y, m, d] = businessDate.split('-') as [string, string, string];
  return `${d}-${m}-${y}`;
}

/**
 * `MM/DD/YYYY` — ledger `entry_date` (§2.3), US field order.
 *
 * §2.3: "the generator only emits days >= 13 in ~30% of rows so the parser
 * cannot cheat by inference" — a day <= 12 is ambiguous with a month in the OTHER
 * order and inference would be right about 70% of the time by accident, which is
 * precisely the false confidence the format-must-be-declared rule exists to rule
 * out. `dayIsUnambiguous` tells the caller which case a given date falls into,
 * so the ~30% target can be enforced at the point the date is CHOSEN rather than
 * discovered after the fact.
 */
export function formatMMDDYYYY(businessDate: string): string {
  const [y, m, d] = businessDate.split('-') as [string, string, string];
  return `${m}/${d}/${y}`;
}

/** True when this date's day-of-month is >13, so MM/DD/YYYY cannot be confused with DD/MM/YYYY. */
export function dayIsUnambiguous(businessDate: string): boolean {
  const day = Number(businessDate.split('-')[2]);
  return day > 13;
}

// ─── identifiers ──────────────────────────────────────────────────────────────

function randomAlnum(rng: Rng, length: number, alphabet: string = ALPHANUMERIC): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[rng.nextInt(0, alphabet.length - 1)];
  return out;
}

/** `pay_` + 14 alphanumeric (§2.1). */
export function genPaymentId(rng: Rng): string {
  return `pay_${randomAlnum(rng, 14)}`;
}

/** `order_` + 14 alphanumeric (§2.1). */
export function genOrderId(rng: Rng): string {
  return `order_${randomAlnum(rng, 14)}`;
}

/** 12-digit numeric RRN (§2.1, §3.2 — the well-formed shape `isWellFormedAnchor` requires). */
export function genRrn(rng: Rng): string {
  // First digit non-zero, so it never accidentally collapses toward looking like
  // a shorter, truncated fragment.
  return `${rng.nextInt(1, 9)}${randomAlnum(rng, 11, '0123456789')}`;
}

/** 16-22 char alphanumeric bank UTR (§2.2). Length varies — real UTRs are not one fixed width. */
export function genUtr(rng: Rng): string {
  return randomAlnum(rng, rng.nextInt(16, 22));
}

/** `setl_` + 14 alphanumeric (§2.1). */
export function genSettlementId(rng: Rng): string {
  return `setl_${randomAlnum(rng, 14)}`;
}

/** `INV/2026/00123`-shaped, sequential within a run so two invoices never collide. */
export function genInvoiceNo(sequence: number): string {
  return `INV/2026/${String(sequence).padStart(5, '0')}`;
}

/** `JE-` + 6 digits (§2.3), sequential. */
export function genEntryId(sequence: number): string {
  return `JE-${String(sequence).padStart(6, '0')}`;
}

/** A 4000-4999 ledger revenue account code (§2.3). Cosmetic; never a matching input. */
export function genAccountCode(rng: Rng): string {
  return String(rng.nextInt(4000, 4999));
}

/**
 * Corrupt a strong-anchor VALUE by transposing one adjacent pair of characters —
 * `REF_TYPO` (§2.4). Deliberately not a blank: the field is present, well-formed
 * *in shape*, and simply wrong, which is what makes it a strictly harder case
 * than `REF_MISSING` for the engine's exact tier to reject correctly rather than
 * silently accept.
 *
 * Picks a position whose swap changes the string (adjacent-equal characters are
 * skipped where an alternative exists), because a transposition that leaves the
 * value byte-identical is not a typo.
 */
export function typoTranspose(rng: Rng, value: string): string {
  if (value.length < 2) return value;
  const positions = Array.from({ length: value.length - 1 }, (_, i) => i)
    .filter((i) => value[i] !== value[i + 1]);
  const i = positions.length > 0 ? rng.pick(positions) : rng.nextInt(0, value.length - 2);
  const chars = value.split('');
  [chars[i], chars[i + 1]] = [chars[i + 1]!, chars[i]!];
  return chars.join('');
}

/** Truncate a bank description mid-token, cutting through whatever anchor it carries (`DESC_TRUNCATED`, §2.4). */
export function truncateMidToken(rng: Rng, description: string): string {
  // Cut somewhere in the back half, so the front (rail prefix, merchant name)
  // usually survives and only the trailing reference is mangled — matching §2.2's
  // "Bank description ... truncated mid-token".
  const cut = rng.nextInt(Math.floor(description.length * 0.4), Math.max(Math.floor(description.length * 0.4), description.length - 3));
  return description.slice(0, Math.max(1, cut));
}
