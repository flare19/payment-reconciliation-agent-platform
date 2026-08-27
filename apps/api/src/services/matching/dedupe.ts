/**
 * S4 — same-source deduplication (ADR-034).
 *
 * RUNS BEFORE MATCHING. The ordering is forced by classification precedence:
 * `DUPLICATE_RECORD` is precedence #1 because a duplicate changes the CARDINALITY
 * of the problem. If dedupe ran after matching, the second copy of a payment
 * would compete for the same bank credit, lose, and be reported as
 * `MISSING_IN_BANK` — inventing a missing bank record that never should have
 * existed, and turning one honest exception into two misleading ones.
 *
 * ---------------------------------------------------------------------------
 * DUPLICATES REQUIRE ANCHOR EVIDENCE. The Day 2 rule — "same strong anchor, OR
 * same amount+date+counterparty within one source" — is wrong in its second half
 * and collides head-on with the dataset's own hardest case:
 *
 *   The IDENTITY_DESTROYED unresolvable class deliberately plants 3+ same-amount,
 *   same-day, same-merchant rows WITH NO ANCHORS in a single source. Under
 *   "amount+date+counterparty => duplicate" those rows classify as duplicates of
 *   each other, when the correct answer is AMBIGUOUS_MATCH. The generator's
 *   hardest designed case would be systematically misclassified by the
 *   classifier's very first rule.
 *
 * It is also false in the real world: two genuine Rs.499 subscription payments to
 * one merchant on one day are ordinary, not a defect.
 *
 * The cluster-size-2 restriction below is the specific guard that keeps the two
 * rules apart: A PAIR LOOKS LIKE A RETRY ARTIFACT, A CROWD LOOKS LIKE AMBIGUITY.
 * ---------------------------------------------------------------------------
 */

import { compareCanonical, type SourceSystem } from '../../types/domain.js';
import type { NormalizedTransaction } from '../../types/engine.js';
import { strongAnchors } from './anchors.js';

export interface DuplicateFinding {
  /** The row being marked. Excluded from matching only when `kind` is 'exact'. */
  transactionId: string;
  /** The surviving row it duplicates — always the lowest source_row_number. */
  primaryTransactionId: string;
  kind: 'exact' | 'suspected';
  /** Human-readable, and the audit `reason`. Never a bare rule id. */
  reason: string;
  /** Which anchor proved it, for 'exact'. Null for 'suspected' — there is none. */
  anchorKey: string | null;
  anchorValue: string | null;
  clusterTransactionIds: string[];
}

export interface DedupeResult {
  /** Records that proceed to matching. Non-primary EXACT duplicates are absent. */
  pool: NormalizedTransaction[];
  findings: DuplicateFinding[];
}

/**
 * Disjoint-set over records, so a row sharing a payment_id with one row and an
 * rrn with another lands in a single cluster rather than two overlapping pairs.
 */
class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined) { this.parent.set(x, x); return x; }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const SEP = '::';

function canonicalSort(rows: NormalizedTransaction[]): NormalizedTransaction[] {
  return [...rows].sort(compareCanonical);
}

/** Cluster values, each canonically sorted, emitted in canonical order of their first member. */
function canonicalClusters(map: Map<string, NormalizedTransaction[]>): NormalizedTransaction[][] {
  return [...map.values()]
    .map(canonicalSort)
    .sort((x, y) => compareCanonical(x[0]!, y[0]!));
}

/**
 * Detect same-source duplicates and elect a primary per cluster.
 *
 * Operates on the RECONCILABLE population only. Excluded rows (failed, draft,
 * void, bank fees) are already out of the denominator, and deduplicating them
 * would produce exceptions for records nobody is reconciling.
 */
export function dedupe(transactions: NormalizedTransaction[]): DedupeResult {
  const reconcilable = transactions.filter((t) => t.statusNorm === 'reconcilable');
  const byId = new Map(reconcilable.map((t) => [t.id, t]));
  const findings: DuplicateFinding[] = [];
  const excluded = new Set<string>();

  // Group by source: duplication is a SAME-SOURCE phenomenon. The same payment
  // appearing in the gateway and in the bank file is the thing we are trying to
  // match, not a duplicate.
  const bySource = new Map<SourceSystem, NormalizedTransaction[]>();
  for (const t of reconcilable) {
    const list = bySource.get(t.sourceSystem);
    if (list === undefined) bySource.set(t.sourceSystem, [t]); else list.push(t);
  }

  // Iterate sources in canonical order so findings are emitted deterministically.
  for (const source of ['gateway', 'bank', 'ledger'] as const) {
    const rows = canonicalSort(bySource.get(source) ?? []);
    if (rows.length < 2) continue;

    // -- EXACT_DUPLICATE: an identical strong anchor --
    const uf = new UnionFind();
    const anchorOwner = new Map<string, string>();
    const anchorForRow = new Map<string, { key: string; value: string }>();

    for (const row of rows) {
      uf.find(row.id);
      for (const anchor of strongAnchors(row.referenceIds)) {
        const slot = anchor.key + SEP + anchor.value;
        const owner = anchorOwner.get(slot);
        if (owner === undefined) {
          anchorOwner.set(slot, row.id);
        } else {
          uf.union(owner, row.id);
          anchorForRow.set(row.id, anchor);
          if (!anchorForRow.has(owner)) anchorForRow.set(owner, anchor);
        }
      }
    }

    const clusters = new Map<string, NormalizedTransaction[]>();
    for (const row of rows) {
      const root = uf.find(row.id);
      const list = clusters.get(root);
      if (list === undefined) clusters.set(root, [row]); else list.push(row);
    }

    const clustered = new Set<string>();
    for (const members of canonicalClusters(clusters)) {
      if (members.length < 2) continue;
      // Lowest source_row_number survives. Deterministic, and it means the FIRST
      // occurrence in the file is the one that reconciles — which is what a human
      // reading the file would also assume.
      const [primary, ...copies] = members as [NormalizedTransaction, ...NormalizedTransaction[]];
      for (const m of members) clustered.add(m.id);
      for (const copy of copies) {
        const anchor = anchorForRow.get(copy.id) ?? anchorForRow.get(primary.id) ?? null;
        excluded.add(copy.id);
        findings.push({
          transactionId: copy.id,
          primaryTransactionId: primary.id,
          kind: 'exact',
          anchorKey: anchor?.key ?? null,
          anchorValue: anchor?.value ?? null,
          clusterTransactionIds: members.map((m) => m.id),
          reason:
            `row ${copy.sourceRowNumber} of the ${source} file repeats ` +
            `${anchor ? `${anchor.key} ${anchor.value}` : 'a reference'} from row ` +
            `${primary.sourceRowNumber}; the first occurrence is reconciled and this copy is not`,
        });
      }
    }

    // -- SUSPECTED_DUPLICATE: amount + date + counterparty, no anchors, EXACTLY 2 --
    const candidates = rows.filter((r) => !clustered.has(r.id) && r.anchorStrength === 'none');
    const buckets = new Map<string, NormalizedTransaction[]>();
    for (const row of candidates) {
      // A row with no counterparty at all is not evidence of anything. Bucketing
      // on null would group every anonymous row in the source together.
      const counterparty = row.counterpartyKey ?? row.counterpartyNorm;
      if (counterparty === null) continue;
      const key = [row.amountPaise, row.txnDate, counterparty, row.direction].join(SEP);
      const list = buckets.get(key);
      if (list === undefined) buckets.set(key, [row]); else list.push(row);
    }

    for (const members of canonicalClusters(buckets)) {
      // THE GUARD. Exactly two, never more. A crowd of identical anchorless rows
      // is the IDENTITY_DESTROYED case and belongs to AMBIGUOUS_MATCH — calling it
      // duplication would resolve, in the classifier's first rule, the exact case
      // the dataset was designed to make unresolvable.
      if (members.length !== 2) continue;
      const [primary, copy] = members as [NormalizedTransaction, NormalizedTransaction];
      findings.push({
        transactionId: copy.id,
        primaryTransactionId: primary.id,
        kind: 'suspected',
        anchorKey: null,
        anchorValue: null,
        clusterTransactionIds: [primary.id, copy.id],
        reason:
          `rows ${primary.sourceRowNumber} and ${copy.sourceRowNumber} of the ${source} file ` +
          `have the same amount, date and counterparty and carry no reference of any kind; ` +
          `this looks like a retry artifact but cannot be proved without a human`,
      });
      // NOTE: deliberately NOT added to `excluded`. Both copies STAY in the
      // matching pool — the engine is not confident enough to remove a record from
      // reconciliation on circumstantial evidence. The exception it raises carries
      // requiresHumanConfirmation instead.
    }
  }

  findings.sort((x, y) => compareCanonical(byId.get(x.transactionId)!, byId.get(y.transactionId)!));

  // The pool is returned in CANONICAL ORDER, not input order. Every collection
  // that feeds a decision is canonically ordered (ADR-032 rule 1), and doing it
  // here removes a whole class of "did the caller remember to sort?" bugs from
  // every stage downstream.
  return {
    pool: canonicalSort(transactions.filter((t) => !excluded.has(t.id))),
    findings,
  };
}
