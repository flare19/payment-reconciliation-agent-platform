/**
 * The audit hash chain (ADR-042).
 *
 *     entry_hash = sha256( canonical_json(entry minus prev_hash/entry_hash) || prev_hash )
 *
 * WHY, given `audit_log` already has a BEFORE UPDATE OR DELETE trigger: the
 * trigger stops tampering *through the application*. Anyone who can drop a
 * trigger can rewrite history, and nothing in the table would show it. The chain
 * converts that from undetectable to detectable — altering one entry invalidates
 * every `entry_hash` after it. That is the difference between "we do not update
 * this table" and "logged immutably", which is what ARCHITECTURE §4.6 claims.
 *
 * ---------------------------------------------------------------------------
 * TWO FIELDS ARE DELIBERATELY OUTSIDE THE HASH, and the reasons are not stylistic.
 *
 * `sequence_no` is `BIGSERIAL` — assigned by the database during INSERT, so it
 * does not exist when the hash must be computed. It cannot be added afterwards
 * either: the append-only trigger forbids the UPDATE. Excluding it costs nothing,
 * because ordering is already enforced by `prev_hash` linkage, which is the
 * stronger guarantee: renumbering rows without breaking the chain is impossible.
 *
 * `occurred_at` IS hashed, which means the application must supply it explicitly
 * rather than letting the column default to `now()`. A DB-side default would be
 * unknown at hash time and every entry would fail verification. The repository
 * enforces this.
 * ---------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { canonicalJson, canonicalize, type CanonicalValue } from './canonical-json.js';

/** The first entry of a chain links from 64 zeros. */
export const GENESIS_HASH = '0'.repeat(64);

/** Exactly the columns that are hashed, in no particular order — keys get sorted. */
export interface HashableAuditEntry {
  runId: string | null;
  eventType: string;
  subjectType: string;
  subjectId: string;
  transactionId: string | null;
  actorType: string;
  actorId: string;
  tier: string | null;
  ruleId: string | null;
  ruleVersion: string | null;
  decision: string | null;
  confidence: number | null;
  beforeState: CanonicalValue;
  afterState: CanonicalValue;
  reason: string;
  details: CanonicalValue;
  occurredAt: Date | string;
}

/** A stored entry, as read back for verification. */
export interface StoredAuditEntry extends HashableAuditEntry {
  sequenceNo: number;
  prevHash: string;
  entryHash: string;
}

/**
 * The entry exactly as it will exist in the database.
 *
 * ONE SOURCE OF TRUTH FOR THE THREE JSON COLUMNS (issue #17). The hash and the
 * column values are both derived from this, so they cannot drift: previously the
 * hash was taken over the caller's object while the columns were written with
 * `JSON.stringify`, and the two disagreed on `details ?? {}` and on
 * `undefined`-valued keys. An untampered entry then failed its own verification.
 *
 * `details` is coerced to `{}` here rather than to JSON `null` because the column
 * is `NOT NULL DEFAULT '{}'` — "details is always an object" is a schema
 * invariant, and this preserves it on both sides of the hash instead of only one.
 *
 * Idempotent, so `verifyChain` can apply it to a row already in stored form.
 */
export function toStoredForm(entry: HashableAuditEntry): HashableAuditEntry {
  return {
    ...entry,
    beforeState: canonicalize(entry.beforeState ?? null),
    afterState: canonicalize(entry.afterState ?? null),
    details: canonicalize(entry.details ?? {}),
  };
}

export function computeEntryHash(entry: HashableAuditEntry, prevHash: string): string {
  // Normalised HERE, not by the caller, so there is no way to hash a shape the
  // database would not have stored.
  const payload = canonicalJson(toStoredForm(entry) as unknown as CanonicalValue);
  return createHash('sha256').update(payload + prevHash, 'utf8').digest('hex');
}

export type DivergenceKind =
  /** The entry's own contents no longer hash to its stored `entry_hash`. Edited in place. */
  | 'entry_altered'
  /** The entry's `prev_hash` does not match its predecessor. An INTERIOR entry was removed, inserted or reordered. */
  | 'chain_broken'
  /**
   * The surviving entries are internally consistent, but the chain does not end
   * where its anchor says it ends — entries are missing from the END, or the
   * terminal hash is not the recorded one (issue #18).
   *
   * This is a different claim from `chain_broken` and cannot be detected the same
   * way: every entry that survives a tail deletion still links correctly to its
   * predecessor, so recomputation alone certifies the truncated log as intact.
   * Only the anchor knows how long the chain should have been.
   */
  | 'chain_truncated';

/** What `audit_chain_heads` records about a chain: how long it is, and where it ends. */
export interface ChainAnchor {
  entryCount: number;
  headHash: string;
}

export interface ChainVerification {
  valid: boolean;
  entriesChecked: number;
  firstDivergenceSequenceNo: number | null;
  /**
   * WHICH KIND of tampering, not just that there was some. "Someone edited this
   * row", "someone removed a row from the middle" and "someone cut the end off"
   * are three different claims about what happened, and a verifier that reports
   * only `false` makes the reader guess.
   */
  divergenceKind: DivergenceKind | null;
  /** The last valid `entry_hash`; the value a next append must chain from. */
  chainHead: string;
  /**
   * Whether an anchor was available at all. `valid: true` on an UNANCHORED chain
   * is the weaker claim "the entries present are consistent" — it says nothing
   * about entries that are absent. Reported rather than implied away.
   */
  anchored: boolean;
  expectedEntryCount: number | null;
  expectedChainHead: string | null;
}

/**
 * Recompute a chain and report the FIRST divergence.
 *
 * First, not all: after one alteration every subsequent entry fails by
 * construction, so listing them would be thousands of rows describing a single
 * event. The first divergence is the event.
 *
 * `entries` must be in `sequence_no` order and must be one chain — a single run,
 * or the `run_id IS NULL` alias-admin chain. Mixing chains reports a spurious
 * break, so the repository selects by chain rather than the caller filtering.
 *
 * `anchor` is the chain's `audit_chain_heads` row. Without it this function can
 * only answer "are the entries I was given consistent?"; with it, it can also
 * answer "am I holding all of them?" — which is the question a truncated log
 * would otherwise pass (issue #18).
 */
export function verifyChain(
  entries: readonly StoredAuditEntry[], anchor: ChainAnchor | null = null,
): ChainVerification {
  const anchorFields = {
    anchored: anchor !== null,
    expectedEntryCount: anchor?.entryCount ?? null,
    expectedChainHead: anchor?.headHash ?? null,
  };
  let expectedPrev = GENESIS_HASH;
  let checked = 0;

  for (const entry of entries) {
    checked += 1;

    if (entry.prevHash !== expectedPrev) {
      return {
        valid: false, entriesChecked: checked,
        firstDivergenceSequenceNo: entry.sequenceNo,
        divergenceKind: 'chain_broken', chainHead: expectedPrev, ...anchorFields,
      };
    }

    const recomputed = computeEntryHash(strip(entry), entry.prevHash);
    if (recomputed !== entry.entryHash) {
      return {
        valid: false, entriesChecked: checked,
        firstDivergenceSequenceNo: entry.sequenceNo,
        divergenceKind: 'entry_altered', chainHead: expectedPrev, ...anchorFields,
      };
    }

    expectedPrev = entry.entryHash;
  }

  // Every entry present is consistent. The anchor is the only thing that can say
  // whether entries are ABSENT — a tail deletion leaves a perfect shorter chain.
  if (anchor !== null && (checked !== anchor.entryCount || expectedPrev !== anchor.headHash)) {
    return {
      valid: false, entriesChecked: checked,
      // The chain ran out before its recorded end; there is no surviving row to
      // point at, which is precisely what makes this kind different.
      firstDivergenceSequenceNo: null,
      divergenceKind: 'chain_truncated', chainHead: expectedPrev, ...anchorFields,
    };
  }

  return {
    valid: true, entriesChecked: checked,
    firstDivergenceSequenceNo: null, divergenceKind: null,
    chainHead: expectedPrev, ...anchorFields,
  };
}

/** Drop the three non-hashed fields, so verification hashes exactly what append hashed. */
function strip(entry: StoredAuditEntry): HashableAuditEntry {
  const { sequenceNo, prevHash, entryHash, ...hashable } = entry;
  void sequenceNo; void prevHash; void entryHash;
  return hashable;
}
