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
 * Reference-shaped tokens, removed from a bank description WHEREVER they appear.
 *
 * A bank description is `RAIL-SETL-MERCHANT-RRN-setl_ID-BATCHnn`, and only the
 * MERCHANT part is a counterparty. The reference parts are already extracted into
 * `reference_ids` and scored by the anchor component; leaving them in the name
 * makes `counterparty_norm` row-unique, which silently destroys the three things
 * that read it — the `byCounterparty` block index, Tier 2's counterparty
 * component, and bank-side alias learning (issue #31).
 *
 * Six or more digits, not four: a merchant legitimately named `SEVEN11` or a
 * four-digit account code should survive, an RRN (12) or a `bank_ref_no` (10–12)
 * should not.
 */
const REFERENCE_DIGITS = /^\d{6,}$/;
/** `pay_…`, `setl_…`, `order_…` after uppercasing. `_` survives §3.3 step 3. */
const STRUCTURED_ID = /^(?:PAY|SETL|ORDER)_[A-Z0-9]+$/;

function isReferenceToken(token: string): boolean {
  return REFERENCE_DIGITS.test(token) || STRUCTURED_ID.test(token) || BATCH_PREFIX.test(token);
}

/** §3.3 step 4, reusable: strip trailing legal suffixes, repeatedly. */
function stripLegalSuffixes(tokens: string[]): string[] {
  const out = [...tokens];
  while (out.length > 1 && LEGAL_SUFFIXES.has(out[out.length - 1]!)) out.pop();
  return out;
}

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
  const tokens = stripLegalSuffixes(s.split(' ').filter(Boolean));

  // `stripLegalSuffixes`'s `length > 1` floor is load-bearing: a merchant
  // legitimately named 'INDIA' or 'CO' must not normalise to the empty string. An
  // empty counterparty_key would collide with every other empty one and turn a
  // missing name into a false match on a component that is supposed to be evidence.
  const result = tokens.join(' ');
  return result === '' ? null : result;
}

/**
 * Apply §3.3 steps 1–5. Used for the bank description blob, which arrives as
 * 'NEFT-SETL-AMZN RETAIL-234567890123-setl_QK2AAb91xxKK01-BATCH12' and needs both
 * its rail scaffolding and its embedded reference numbers removed before the
 * merchant name inside it is comparable to anything.
 *
 * The reference tokens are dropped WHEREVER they sit, not only at the tail. An
 * earlier version stripped a trailing `BATCH\d+` and then a trailing digit run,
 * which is exactly right for schema.md §2.2's worked example (`…-AMZN
 * RETAIL-234567890123-BATCH12`) and wrong for the shape the generator actually
 * emits, where a `setl_…` token sits between the RRN and the BATCH marker and
 * halts a tail-anchored loop. That left the RRN embedded in 248 of 301 bank rows
 * and made `counterparty_norm` a near-primary-key (issue #31).
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

  // Drop every reference-shaped token, at any position. Unlike the guards above
  // this is NOT floored at one surviving token: a description that is nothing but
  // references genuinely carries no counterparty, and `null` says that honestly.
  // A leftover RRN would instead be a name that matches nothing and buckets alone.
  tokens = tokens.filter((t) => !isReferenceToken(t));

  // Re-apply §3.3 step 4. A legal suffix that was not final before the reference
  // tokens were removed is final now: `ZOMATO LIMITED 818624673100 SETL_…` has to
  // reach `ZOMATO`, or the bank leg still fails to meet the gateway's `ZOMATO`.
  tokens = stripLegalSuffixes(tokens);

  const result = tokens.join(' ');
  return result === '' ? null : result;
}
