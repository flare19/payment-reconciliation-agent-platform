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
import { canonicalJson, type CanonicalValue } from './canonical-json.js';

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

export function computeEntryHash(entry: HashableAuditEntry, prevHash: string): string {
  const payload = canonicalJson(entry as unknown as CanonicalValue);
  return createHash('sha256').update(payload + prevHash, 'utf8').digest('hex');
}

export type DivergenceKind =
  /** The entry's own contents no longer hash to its stored `entry_hash`. Edited in place. */
  | 'entry_altered'
  /** The entry's `prev_hash` does not match its predecessor. An entry was removed, inserted or reordered. */
  | 'chain_broken';

export interface ChainVerification {
  valid: boolean;
  entriesChecked: number;
  firstDivergenceSequenceNo: number | null;
  /**
   * WHICH KIND of tampering, not just that there was some. "Someone edited this
   * row" and "someone removed a row" are different claims about what happened,
   * and a verifier that reports only `false` makes the reader guess.
   */
  divergenceKind: DivergenceKind | null;
  /** The last valid `entry_hash`; the value a next append must chain from. */
  chainHead: string;
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
 */
export function verifyChain(entries: readonly StoredAuditEntry[]): ChainVerification {
  let expectedPrev = GENESIS_HASH;
  let checked = 0;

  for (const entry of entries) {
    checked += 1;

    if (entry.prevHash !== expectedPrev) {
      return {
        valid: false, entriesChecked: checked,
        firstDivergenceSequenceNo: entry.sequenceNo,
        divergenceKind: 'chain_broken', chainHead: expectedPrev,
      };
    }

    const recomputed = computeEntryHash(strip(entry), entry.prevHash);
    if (recomputed !== entry.entryHash) {
      return {
        valid: false, entriesChecked: checked,
        firstDivergenceSequenceNo: entry.sequenceNo,
        divergenceKind: 'entry_altered', chainHead: expectedPrev,
      };
    }

    expectedPrev = entry.entryHash;
  }

  return {
    valid: true, entriesChecked: checked,
    firstDivergenceSequenceNo: null, divergenceKind: null, chainHead: expectedPrev,
  };
}

/** Drop the three non-hashed fields, so verification hashes exactly what append hashed. */
function strip(entry: StoredAuditEntry): HashableAuditEntry {
  const { sequenceNo, prevHash, entryHash, ...hashable } = entry;
  void sequenceNo; void prevHash; void entryHash;
  return hashable;
}
