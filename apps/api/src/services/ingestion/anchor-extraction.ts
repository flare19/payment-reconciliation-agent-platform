/**
 * Anchor extraction at ingestion — what references a row carries, and how strong
 * that makes its identity (schema.md §3.1, §3.2).
 *
 * Ingestion's job is to record what the source *stated*, not to decide whether
 * it is correct — a transposed reference is still a reference the source put in
 * a field of its own, and only comparison against a counterpart (a matching-
 * engine concern) can reveal the transposition. So this module is deliberately
 * shallow: shape checks, never cross-row logic.
 */

import type { AnchorStrength } from '../../types/domain.js';
import type { ReferenceIds } from '../../types/engine.js';

const RRN = /^\d{12}$/;
const SETTLEMENT_ID = /^setl_[A-Za-z0-9]{14}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{14}$/;
const ORDER_ID = /^order_[A-Za-z0-9]{14}$/;

const isNonEmpty = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';

/**
 * Reference-shaped tokens embedded in the bank description blob
 * (`"UPI-SETL-FSN E-COMMERCE-510996260123-setl_xot9xgPg5duO6q-BATCH81"`).
 *
 * These are ALWAYS weak (schema.md §3.1): identity may only rest on a value the
 * source stated in a structured field, never on one recovered by regex from
 * free text. Merchant-name words are intentionally NOT collected here — they are
 * the counterparty component's input, and putting them in the anchor bag would
 * let a name coincidence score as reference evidence.
 *
 * A description truncated mid-token (`DESC_TRUNCATED`, ~10% of bank rows) simply
 * yields fewer tokens or none — an 11-digit fragment is not a well-formed RRN
 * and is correctly ignored.
 */
export function extractDescriptionAnchors(description: string | null | undefined): string[] {
  if (description === null || description === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Split on anything that is not part of an identifier token. `_` is kept so
  // `setl_xxx` / `pay_xxx` survive whole; spaces and dashes are separators.
  for (const tok of description.split(/[^A-Za-z0-9_]+/)) {
    if (tok === '' || seen.has(tok)) continue;
    if (RRN.test(tok) || SETTLEMENT_ID.test(tok) || PAYMENT_ID.test(tok) || ORDER_ID.test(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

/**
 * Record-level anchor strength (schema.md §3.2). This is coarser than
 * `services/matching/anchors.ts`'s `STRONG_ANCHOR_KEYS` on purpose: that list
 * says which anchor *types can carry an exact-tier match* (and includes `utr`
 * and `entry_id` for same-source dedup); this says whether the row has an
 * identity a human could not have found — the distinction the classifier needs
 * between "we couldn't find it" and "there was nothing to find".
 *
 *   strong  — a structured, globally-unique id: `payment_id`, `settlement_id`,
 *             or a well-formed 12-digit `rrn` in a field of its own.
 *   weak    — narrows candidates but cannot confirm alone: `order_id`,
 *             `bank_ref_no`, or any description-extracted token.
 *   none    — nothing usable. A bank `MISC_CREDIT`, or a ledger row whose
 *             `gateway_ref` is blank. `utr` and `entry_id` alone do NOT lift a
 *             row above `none` here — they are never cross-source identity.
 */
export function anchorStrengthOf(refs: ReferenceIds): AnchorStrength {
  const structuredStrong =
    isNonEmpty(refs.payment_id) ||
    isNonEmpty(refs.settlement_id) ||
    (isNonEmpty(refs.rrn) && RRN.test(refs.rrn));
  if (structuredStrong) return 'strong';

  const weak =
    isNonEmpty(refs.order_id) ||
    isNonEmpty(refs.bank_ref_no) ||
    (refs.extracted_from_description !== undefined && refs.extracted_from_description.length > 0);
  return weak ? 'weak' : 'none';
}
