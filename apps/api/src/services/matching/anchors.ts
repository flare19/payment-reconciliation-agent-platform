/**
 * Anchor extraction and comparison — the shared vocabulary of identity.
 *
 * Anchors are used at S4 (dedupe), S6/S7 (exact and alias tiers), S8 (identity
 * short-circuit) and S9 (fuzzy scoring). This module exists so all four ask the
 * same question and get the same answer. Four stages each deciding for themselves
 * what "a well-formed RRN" means is four chances to disagree, and a disagreement
 * here does not throw — it silently changes which records are considered the same
 * payment.
 */

import type { ReferenceIds } from '../../types/engine.js';
import { STRONG_ANCHOR_KEYS, type StrongAnchorKey } from '../../types/engine.js';

/** References that narrow candidates but cannot confirm identity alone. */
export const WEAK_ANCHOR_KEYS = ['order_id', 'bank_ref_no'] as const;

export interface AnchorEntry {
  key: StrongAnchorKey;
  value: string;
}

/**
 * Is this anchor value usable as identity?
 *
 * A 12-digit RRN is a strong anchor; a malformed one is not (schema.md §3.2).
 * The distinction matters because the generator truncates ~10% of bank
 * descriptions mid-token — a 7-digit fragment of an RRN looks like a reference
 * and is not one, and treating it as identity would match on a prefix collision.
 */
export function isWellFormedAnchor(key: string, value: string): boolean {
  if (key === 'rrn') return /^\d{12}$/.test(value);
  return value.trim().length > 0;
}

/** Read a structured (not description-extracted) reference value. */
export function structuredValue(refs: ReferenceIds, key: string): string | undefined {
  const v = (refs as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Every well-formed STRONG anchor a record carries, in the canonical key order of
 * `STRONG_ANCHOR_KEYS`. Description-extracted values are deliberately excluded:
 * they are always weak (schema.md §3.1), and identity may only rest on a value
 * the source stated in a field of its own.
 */
export function strongAnchors(refs: ReferenceIds): AnchorEntry[] {
  const out: AnchorEntry[] = [];
  for (const key of STRONG_ANCHOR_KEYS) {
    const value = structuredValue(refs, key);
    if (value !== undefined && isWellFormedAnchor(key, value)) out.push({ key, value });
  }
  return out;
}

/**
 * The first strong anchor both records share, or null.
 *
 * Deterministic: iterates `STRONG_ANCHOR_KEYS` in declaration order, so two
 * records sharing both a `payment_id` and an `rrn` always report the
 * `payment_id`. Which anchor is named ends up in the audit trail and in the
 * exception's rule id, so "whichever was found first" must not depend on object
 * key ordering.
 */
export function sharedStrongAnchor(a: ReferenceIds, b: ReferenceIds): AnchorEntry | null {
  for (const key of STRONG_ANCHOR_KEYS) {
    const av = structuredValue(a, key);
    const bv = structuredValue(b, key);
    if (av !== undefined && bv !== undefined && av === bv
        && isWellFormedAnchor(key, av) && isWellFormedAnchor(key, bv)) {
      return { key, value: av };
    }
  }
  return null;
}

/**
 * The same reference VALUE stated by both records under keys of DIFFERENT types —
 * a gateway `rrn` against a bank `bank_ref_no`, or a gateway `settlement_id`
 * against a value regex'd out of a bank description blob (#38, #51).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THIS IS NOT IDENTITY AND MAY NEVER BE USED AS IDENTITY.
 *
 * `sharedStrongAnchor` above answers "are these the same payment?" and S4, S6,
 * S7 and S8 rest on its answer. This function answers something much weaker:
 * "do these two rows mention the same reference number anywhere?" `bank_ref_no`
 * is documented as *sometimes* equal to the RRN and description-extracted values
 * are always weak (schema.md §2.2, §3.1), so a hit here is EVIDENCE, never proof.
 *
 * Its only legitimate callers are the two stages that weigh evidence rather than
 * assert identity: `scoring.ts`'s `anchorAgreement` (S9, where it earns the
 * `strong_weak` band and never more) and `findSplitSettlement` (S10, where it
 * admits a candidate leg that must still survive an arithmetic proof). Calling
 * it from dedupe or the exact tiers would let a coincidental `bank_ref_no`
 * collapse two different payments into one.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Returns the STRONG key, which is the one that names the evidence. Iteration is
 * `STRONG_ANCHOR_KEYS` order, then direction, then weak-key order, so a pair
 * agreeing under two keys always reports the same one (ADR-032).
 */
export function sharedReferenceValue(
  a: ReferenceIds, b: ReferenceIds,
): AnchorEntry | null {
  const extracted = (refs: ReferenceIds): readonly string[] =>
    refs.extracted_from_description ?? [];
  for (const strongKey of STRONG_ANCHOR_KEYS) {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const value = structuredValue(x, strongKey);
      if (value === undefined || !isWellFormedAnchor(strongKey, value)) continue;
      for (const weakKey of WEAK_ANCHOR_KEYS) {
        const wv = structuredValue(y, weakKey);
        if (wv !== undefined && wv === value && isWellFormedAnchor(weakKey, wv)) {
          return { key: strongKey, value };
        }
      }
      if (extracted(y).includes(value)) return { key: strongKey, value };
    }
  }
  return null;
}

/**
 * A strong anchor of the same type present on both sides with DIFFERENT values.
 *
 * Positive evidence that two records are different things, not merely an absence
 * of evidence that they are the same — which is why a contradiction discards a
 * candidate rather than scoring it low (ADR-010).
 */
export function contradictingStrongAnchor(
  a: ReferenceIds, b: ReferenceIds,
): { key: StrongAnchorKey; aValue: string; bValue: string } | null {
  for (const key of STRONG_ANCHOR_KEYS) {
    const av = structuredValue(a, key);
    const bv = structuredValue(b, key);
    if (av !== undefined && bv !== undefined && av !== bv
        && isWellFormedAnchor(key, av) && isWellFormedAnchor(key, bv)) {
      return { key, aValue: av, bValue: bv };
    }
  }
  return null;
}
