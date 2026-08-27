/**
 * Counterparty normalization (schema.md §3.3).
 *
 * Deterministic and rule-based. NO FUZZY LOGIC HERE — similarity belongs in the
 * Tier 2 scorer, and mixing the two would make it impossible to say whether two
 * names matched because they are literally the same after cleaning or because a
 * trigram score crossed a line.
 *
 * The output is deliberately INCOMPLETE as a matching mechanism:
 *   'Amazon Retail India Pvt Ltd' -> 'AMAZON RETAIL'
 *   'AMZN'                        -> 'AMZN'
 * Those still do not match, and that residual gap is exactly what `learned_aliases`
 * exists to close with a human assertion (ADR-012). Normalization that tried to
 * close it itself would be guessing.
 */

/** Stripped from the END, repeatedly. Order within the set does not matter. */
const LEGAL_SUFFIXES = new Set([
  'PVT', 'PRIVATE', 'LTD', 'LIMITED', 'LLP', 'INC', 'CORP', 'CO', 'INDIA', 'IN',
]);

/** Stripped from the START of bank description blobs, repeatedly. */
const RAIL_PREFIXES = new Set(['NEFT', 'IMPS', 'UPI', 'SETL', 'SETTLEMENT', 'MPS']);
const BATCH_PREFIX = /^BATCH\d+$/;

/**
 * Apply §3.3 steps 1–4. Used for gateway `merchant_name` and ledger `customer_name`.
 */
export function normalizeCounterparty(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  // 1. NFKC, trim, collapse whitespace. NFKC folds full-width and compatibility
  //    forms, so 'ＡＭＺＮ' and 'AMZN' normalise together.
  let s = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (s === '') return null;

  // 2. Uppercase.
  s = s.toUpperCase();

  // 3. Punctuation to space, then re-collapse.
  s = s.replace(/[.,'"\-\/&()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s === '') return null;

  // 4. Strip trailing legal suffixes, repeatedly: 'INDIA PVT LTD' needs three passes.
  let tokens = s.split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }

  // `tokens.length > 1` above is load-bearing: a merchant legitimately named
  // 'INDIA' or 'CO' must not normalise to the empty string. An empty
  // counterparty_key would collide with every other empty one and turn a missing
  // name into a false match on a component that is supposed to be evidence.
  const result = tokens.join(' ');
  return result === '' ? null : result;
}

/**
 * Apply §3.3 steps 1–5. Used for the bank description blob, which arrives as
 * 'NEFT-SETL-AMZN RETAIL-234567890123-BATCH12' and needs its rail scaffolding
 * removed before the merchant name inside it is comparable to anything.
 */
export function normalizeBankDescription(raw: string | null | undefined): string | null {
  const base = normalizeCounterparty(raw);
  if (base === null) return null;

  let tokens = base.split(' ').filter(Boolean);

  // 5. Strip rail prefixes from the front, repeatedly.
  while (tokens.length > 1) {
    const head = tokens[0]!;
    if (RAIL_PREFIXES.has(head) || BATCH_PREFIX.test(head)) tokens.shift();
    else break;
  }

  // BATCH tokens also trail ('...-BATCH12'), so strip them from the end too. They
  // are batch identifiers, not part of any merchant's name, and leaving them in
  // would make two settlements for the same merchant look like different parties.
  while (tokens.length > 1 && BATCH_PREFIX.test(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }

  // A bare digit run is a reference number, not a name. Dropping it keeps the
  // counterparty component scoring on words rather than on an RRN that the anchor
  // component already scores properly.
  while (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }

  const result = tokens.join(' ');
  return result === '' ? null : result;
}
