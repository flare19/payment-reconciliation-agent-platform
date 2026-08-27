/**
 * S12 — exception classification.
 *
 * Turns the stage outputs into `ClassifiedException` rows: one primary category
 * per record, the rest as flags, with `evidence` recording what the engine tried.
 *
 * ---------------------------------------------------------------------------
 * PRESENCE AND VALUE ARE MUTUALLY EXCLUSIVE, and that is enforced here rather
 * than left to the precedence order.
 *
 *   "You cannot have an amount disagreement with a record that isn't there."
 *
 * The discriminator is identity: if a counterpart's strong anchor AGREES, the
 * question is what its value says (AMOUNT_MISMATCH / TIMING_DRIFT). If no
 * counterpart shares an anchor, the record is absent (MISSING_IN_*). Letting both
 * fire would report the same fact twice under two names and inflate the exception
 * count — which is the number under the most scrutiny.
 * ---------------------------------------------------------------------------
 */

import { compareCanonical, type ExceptionCategory, type Paise, type SourceSystem } from '../../types/domain.js';
import type {
  ClassifiedException, ExceptionEvidence, NormalizedTransaction, RunConfig, ScoredCandidate,
} from '../../types/engine.js';
import type { DuplicateFinding } from '../matching/dedupe.js';
import type { IdentityVerdict } from '../matching/identity-resolution.js';
import type { AmbiguityFinding } from '../matching/assignment.js';
import type { BatchOutcome } from '../matching/batch-decomposition.js';
import { dateWindowFor } from '../matching/tolerance.js';
import { dayDelta } from '../ingestion/dates.js';
import { applyPrecedence } from './precedence.js';
import { computeSeverity } from './severity.js';
import { emptyEvidence } from './evidence.js';

/**
 * Every candidate S5/S9 scored for one record — including ones discarded
 * before scoring and ones scored below the review threshold — plus whether
 * the per-record candidate cap bound and who its counterpart ultimately went
 * to. Populates a presence exception's `evidence.candidates`,
 * `.candidatesConsidered`, `.candidateCapHit` and `.displacedByMatchId`
 * (matching-engine.md §11, schema.md §8, issue #8).
 */
export interface RecordCandidateEvidence {
  candidates: ScoredCandidate[];
  capHit: boolean;
  displacedByMatchId?: string | null;
}

/** Everything S12 needs from the stages upstream of it. */
export interface ClassificationInput {
  /** Post-dedupe reconcilable population, canonically ordered. */
  pool: NormalizedTransaction[];
  duplicates: DuplicateFinding[];
  identity: { pair: [NormalizedTransaction, NormalizedTransaction]; verdict: IdentityVerdict }[];
  ambiguities: AmbiguityFinding[];
  batches: { credit: NormalizedTransaction; outcome: BatchOutcome }[];
  /** Confirmed pairs from S6/S7/S9 — used to decide which legs are genuinely absent. */
  matchedPairs: { aId: string; bId: string }[];
  /**
   * Keyed by the transactionId the candidates were scored FOR. Optional, and
   * an absent map (or an absent entry for one record) is not yet distinguished
   * from "the engine genuinely tried nothing" — no real caller populates this
   * today (S5 blocking and S9 assignment are not wired into S12 yet); this
   * exists so the shape is designed once rather than bolted on later.
   */
  scoredCandidates?: Map<string, RecordCandidateEvidence>;
  config: RunConfig;
}

interface Signal {
  category: ExceptionCategory;
  amountAtRiskPaise: Paise | null;
  reason: string;
  ruleId: string;
  related: string[];
  evidence: Partial<ExceptionEvidence>;
  duplicateKind?: 'exact' | 'suspected';
  requiresHumanConfirmation?: boolean;
  bestCandidateScore?: number | null;
}

export function classify(input: ClassificationInput): ClassifiedException[] {
  const { pool, config } = input;
  const byId = new Map(pool.map((t) => [t.id, t]));
  const signals = new Map<string, Signal[]>();

  // Every id the classifier can emit an exception for, not just the surviving
  // pool: an excluded exact DUPLICATE_RECORD never enters `pool` (ADR-032,
  // issue #2), so the output-order comparator needs a second source for its key.
  const sortKeyFor = new Map<string, { sourceSystem: SourceSystem; sourceRowNumber: number }>(
    pool.map((t) => [t.id, t]));
  for (const d of input.duplicates) {
    if (!sortKeyFor.has(d.transactionId)) {
      sortKeyFor.set(d.transactionId, { sourceSystem: d.sourceSystem, sourceRowNumber: d.sourceRowNumber });
    }
  }

  const add = (transactionId: string, signal: Signal): void => {
    const list = signals.get(transactionId);
    if (list === undefined) signals.set(transactionId, [signal]); else list.push(signal);
  };

  // -- 1. Duplicates (S4) ----------------------------------------------------
  // A non-primary EXACT copy never entered the matching pool, so it can never
  // also carry a presence finding. That is the point of running dedupe first.
  for (const d of input.duplicates) {
    add(d.transactionId, {
      category: 'DUPLICATE_RECORD',
      amountAtRiskPaise: byId.get(d.transactionId)?.amountPaise ?? null,
      reason: d.reason,
      ruleId: d.kind === 'exact' ? 'DEDUP_STRONG_ANCHOR_V1' : 'DEDUP_SUSPECTED_PAIR_V1',
      related: d.clusterTransactionIds.filter((id) => id !== d.transactionId),
      evidence: { anchorStrength: d.kind === 'exact' ? 'strong' : 'none' },
      duplicateKind: d.kind,
      requiresHumanConfirmation: d.kind === 'suspected',
    });
  }

  // -- 2. Identity verdicts (S8) --------------------------------------------
  // The only source of AMOUNT_MISMATCH and TIMING_DRIFT. Records that reach here
  // have an established identity, so they are excluded from presence below.
  const identityEstablished = new Set<string>();
  for (const { pair, verdict } of input.identity) {
    if (verdict.kind !== 'established') continue;
    const [a, b] = pair;
    identityEstablished.add(`${a.id}::${b.sourceSystem}`);
    identityEstablished.add(`${b.id}::${a.sourceSystem}`);
    if (verdict.category === null) continue;

    for (const [self, other] of [[a, b], [b, a]] as const) {
      add(self.id, {
        category: verdict.category,
        amountAtRiskPaise: verdict.amountAtRiskPaise,
        reason: verdict.reason,
        ruleId: verdict.ruleId,
        related: [other.id],
        evidence: {
          anchorStrength: 'strong',
          comparisonBasis: verdict.amount.basis,
          windowUsed: {
            amountBandPaise: verdict.amount.tolerancePaise,
            dateWindow: verdict.date.window,
          },
          // A reviewer can confirm a pure timing drift in one click, so the actual
          // delta is recorded rather than left to be re-derived.
          wouldMatchIfWindowWidened: verdict.outcome === 'timing_drift'
            ? { dateDeltaDays: verdict.date.deltaDays } : null,
        },
      });
      for (const flag of verdict.secondaryFlags) {
        add(self.id, {
          category: flag,
          amountAtRiskPaise: verdict.amountAtRiskPaise,
          reason: verdict.reason,
          ruleId: verdict.ruleId,
          related: [other.id],
          evidence: {},
        });
      }
    }
  }

  // -- 3. Batch outcomes (S10) ----------------------------------------------
  for (const { credit, outcome } of input.batches) {
    if (outcome.kind === 'decomposed') continue;
    if (outcome.kind === 'ambiguous') {
      add(credit.id, {
        category: 'AMBIGUOUS_MATCH',
        amountAtRiskPaise: credit.amountPaise,
        reason: outcome.reason,
        ruleId: 'BATCH_AMBIGUOUS_V1',
        related: [...new Set(outcome.subsets.flat())],
        evidence: { candidateSubsets: outcome.subsets, anchorStrength: credit.anchorStrength },
      });
      continue;
    }
    add(credit.id, {
      category: 'UNSPLITTABLE_BATCH',
      amountAtRiskPaise: credit.amountPaise,
      reason: outcome.reason,
      ruleId: 'BATCH_UNSPLITTABLE_V1',
      related: [],
      evidence: {
        anchorStrength: credit.anchorStrength,
        // Two DIFFERENT claims, never collapsed (ADR-038, ADR-060). Exactly one
        // of these is ever non-null.
        searchExhausted: outcome.stats.exhaustive ? true : null,
        searchBoundExceeded: outcome.stats.boundHit ?? null,
      },
    });
  }

  // -- 4. Ambiguity guard (S9) ----------------------------------------------
  for (const finding of input.ambiguities) {
    const self = byId.get(finding.transactionId);
    add(finding.transactionId, {
      category: 'AMBIGUOUS_MATCH',
      amountAtRiskPaise: self?.amountPaise ?? null,
      reason:
        `two candidates in the ${finding.targetSource} source scored within ` +
        `${finding.delta} of each other; the engine did not choose between them`,
      ruleId: 'CLASSIFY_AMBIGUOUS_MATCH_V1',
      related: finding.rivals.map((r) => r.transactionId),
      bestCandidateScore: finding.rivals[0]?.score ?? null,
      evidence: {
        anchorStrength: self?.anchorStrength ?? 'none',
        candidatesConsidered: finding.rivals.length,
        candidates: finding.rivals.map((r) => ({
          transactionId: r.transactionId,
          sourceSystem: finding.targetSource,
          score: r.score,
          rejectedBecause:
            `tied with another candidate to within ${finding.delta}; refusing to choose ` +
            `is preferable to a confident wrong match`,
        })),
      },
    });
  }

  // -- 5. Presence (everything still unaccounted for) ------------------------
  const matchedWith = new Map<string, Set<SourceSystem>>();
  for (const { aId, bId } of input.matchedPairs) {
    const a = byId.get(aId), b = byId.get(bId);
    if (a === undefined || b === undefined) continue;
    addSource(matchedWith, aId, b.sourceSystem);
    addSource(matchedWith, bId, a.sourceSystem);
  }

  const duplicated = new Set(input.duplicates.filter((d) => d.kind === 'exact')
    .map((d) => d.transactionId));

  for (const record of pool) {
    if (record.statusNorm !== 'reconcilable') continue;
    if (duplicated.has(record.id)) continue;
    // A record the engine already refused to decide about is not "missing" a
    // counterpart — it found too many. Reporting both would count one problem twice.
    if ((signals.get(record.id) ?? []).some(
      (s) => s.category === 'AMBIGUOUS_MATCH' || s.category === 'UNSPLITTABLE_BATCH')) continue;

    for (const target of missingTargetsFor(record)) {
      if (matchedWith.get(record.id)?.has(target) === true) continue;
      // The discriminator: an established identity means this is a VALUE question,
      // already answered above. Presence must not also fire.
      if (identityEstablished.has(`${record.id}::${target}`)) continue;

      const due = settlementDue(record, target, config);
      if (!due.overdue) continue;   // in flight, not missing (ADR-039)

      const category = missingCategoryFor(target);
      const scored = input.scoredCandidates?.get(record.id);
      add(record.id, {
        category,
        amountAtRiskPaise: record.amountPaise,
        reason:
          `no ${target} record shares an identity reference with this ` +
          `${record.sourceSystem} record, and its ${due.windowLabel} settlement window ` +
          `closed ${due.daysOverdue} day(s) before the run's reference date`,
        ruleId: `CLASSIFY_${category}_V1`,
        related: [],
        evidence: {
          anchorStrength: record.anchorStrength,
          candidatesConsidered: scored?.candidates.length ?? 0,
          candidates: (scored?.candidates ?? []).map(candidateEvidenceOf),
          candidateCapHit: scored?.capHit ?? false,
          displacedByMatchId: scored?.displacedByMatchId ?? null,
          windowUsed: { amountBandPaise: 0, dateWindow: due.window },
        },
      });
    }
  }

  // -- Assemble -------------------------------------------------------------
  const out: ClassifiedException[] = [];
  for (const [transactionId, list] of signals) {
    const ranked = applyPrecedence(list.map((s) => s.category));
    if (ranked === null) continue;
    const primary = list.find((s) => s.category === ranked.primary)!;

    const { severity, basis } = computeSeverity(
      ranked.primary, primary.amountAtRiskPaise, config,
      primary.duplicateKind === undefined ? {} : { duplicateKind: primary.duplicateKind });

    const evidence: ExceptionEvidence = {
      ...emptyEvidence(),
      ...primary.evidence,
      severityBasis: {
        base: basis.base,
        amountAtRiskPaise: basis.amountAtRiskPaise,
        escalated: basis.escalated,
      },
    };

    out.push({
      transactionId,
      relatedTransactionIds: [...new Set(list.flatMap((s) => s.related))].sort(),
      category: ranked.primary,
      secondaryFlags: ranked.secondaryFlags,
      severity,
      amountAtRiskPaise: primary.amountAtRiskPaise,
      requiresHumanConfirmation: primary.requiresHumanConfirmation ?? false,
      bestCandidateScore: primary.bestCandidateScore ?? null,
      evidence,
      detectedByRule: primary.ruleId,
      ruleVersion: config.ruleVersion,
    });
  }

  // Canonical order, so two runs that discovered the same facts in a different
  // sequence emit byte-identical rows (ADR-032). Uses `sortKeyFor`, not `byId`
  // — an excluded exact duplicate has no entry in `byId`, and falling back to
  // it here is exactly what made this comparator non-transitive (issue #2).
  out.sort((x, y) => {
    const a = sortKeyFor.get(x.transactionId ?? ''), b = sortKeyFor.get(y.transactionId ?? '');
    if (a === undefined || b === undefined) return 0;
    return compareCanonical(a, b);
  });
  return out;
}

function addSource(map: Map<string, Set<SourceSystem>>, id: string, source: SourceSystem): void {
  const set = map.get(id);
  if (set === undefined) map.set(id, new Set([source])); else set.add(source);
}

/** Which other sources this record is expected to appear in. */
function missingTargetsFor(record: NormalizedTransaction): SourceSystem[] {
  switch (record.sourceSystem) {
    case 'gateway': return ['bank', 'ledger'];
    // A bank or ledger row without a gateway counterpart is MISSING_IN_GATEWAY.
    // Neither is expected to reconcile directly against the other: no arithmetic
    // relates them without the gateway row in between (ADR-037).
    case 'bank':    return ['gateway'];
    case 'ledger':  return ['gateway'];
  }
}

function missingCategoryFor(target: SourceSystem): ExceptionCategory {
  return target === 'bank' ? 'MISSING_IN_BANK'
    : target === 'ledger' ? 'MISSING_IN_LEDGER'
    : 'MISSING_IN_GATEWAY';
}

/**
 * `ScoredCandidate` -> `evidence.candidates` row. `rejectedBecause` is required
 * on the evidence shape (schema.md §8: "records what the engine tried"), but
 * optional on `ScoredCandidate` — null there means "scored, not gate-discarded,
 * simply not chosen", so a reason is derived from the score itself rather than
 * left blank. Never fabricated: only the score the engine already computed.
 */
function candidateEvidenceOf(c: ScoredCandidate): ExceptionEvidence['candidates'][number] {
  return {
    transactionId: c.transactionId,
    sourceSystem: c.sourceSystem,
    score: c.score,
    scoreBreakdown: c.breakdown,
    rejectedBecause: c.rejectedBecause ?? `scored ${c.score.toFixed(4)}, below the review threshold`,
  };
}

/**
 * Has the settlement window closed, relative to `config.referenceDate`?
 *
 * NEVER the wall clock (ADR-039). A gateway payment captured yesterday is not
 * "missing from the bank" — it is in flight, and calling it an exception would
 * put a normal in-progress payment in front of a controller as a problem.
 *
 * `record` is always the one MISSING a counterpart here (`missingTargetsFor`
 * calls this once per candidate `target`). Its own source system, not
 * `target`, decides which ADR-009 window applies — `target` is always
 * 'gateway' for a bank or ledger record, so branching on it alone cannot tell
 * those two apart (issue #5).
 */
function settlementDue(
  record: NormalizedTransaction, target: SourceSystem, config: RunConfig,
): { overdue: boolean; daysOverdue: number; window: readonly [number, number]; windowLabel: string } {
  const elapsed = dayDelta(record.txnDate, config.referenceDate);

  const window =
    record.sourceSystem === 'gateway'
      ? dateWindowFor(target === 'bank' ? 'gateway_bank' : 'gateway_ledger', record.method, config)
      // A ledger record's missing gateway counterpart: ADR-009's gateway<->ledger
      // window applies symmetrically, regardless of which side is asking.
      : record.sourceSystem === 'ledger'
        ? dateWindowFor('gateway_ledger', null, config)
        // A bank record's missing gateway counterpart: no ADR-009 window is
        // defined in this direction (settlement flows FORWARD from the gateway
        // capture, so there is no "gateway settling into bank" window to
        // invert). This is its own stated fallback rule, not a reuse of
        // dateWindowCardDays (ADR-065).
        : config.dateWindowGatewayLookbackDays;

  return {
    overdue: elapsed > window[1],
    daysOverdue: elapsed - window[1],
    window,
    windowLabel: `T+${window[1]}`,
  };
}
