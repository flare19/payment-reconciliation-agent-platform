/**
 * The scoring arithmetic (docs/validation-strategy.md §5).
 *
 * Pure functions over two inputs: the answer key, and a snapshot of what the
 * engine produced. No I/O, no API client, no file reads — so every judgment call
 * below is testable in isolation, which matters more here than anywhere else in
 * the repo:
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ NO TEST CAN CATCH A SCORER THAT IS WRONG IN THE DIRECTION YOU HOPED.     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A matching engine that is wrong produces a visibly odd exception list. A
 * SCORER that is wrong produces a plausible number, and the more flattering it
 * is the less likely anyone is to go looking. Every denominator adjustment in
 * this file is therefore reported as a COUNT alongside the ratio it affects, so
 * a reader can see what was excluded rather than having to trust that the
 * exclusion was principled.
 *
 * ── THE THREE JUDGMENT CALLS, AND WHERE THEY ARE SETTLED ──
 *
 *  1. `viaTier` — settled by ADR-072 / §5.1.2. It is NEVER a term in precision,
 *     recall or F1. Correctness is pair membership alone. Tier attribution is
 *     reported as a diagnostic against the engine's own per-tier PAIR counts
 *     (`runs.metrics.tierAttribution`), never against `matches.tier`, which
 *     describes a GROUP at its weakest constituent tier (§10 rule 5) and
 *     disagrees with the key for 63% of matched pairs.
 *
 *  2. `pending_review` — settled by §5.1.1 / ADR-040. A proposal is not a claim.
 *     Pending pairs are in NEITHER the primary numerator nor its denominator,
 *     and are scored separately as `reviewQueuePrecision`: "when this engine
 *     asks a human, is it asking about the right things?"
 *
 *  3. The group→pair mapping. A group of N members asserts all N(N−1)/2 internal
 *     pairs — including the leg no tier proposed directly, which is implied by
 *     the other two meeting at the anchor. Those implied pairs are real claims
 *     and are scored as such: if the engine puts a gateway, a bank and a ledger
 *     row in one group, it has asserted the bank↔ledger relationship whether or
 *     not any rule looked at it, and a scorer that ignored implied pairs would
 *     let a wrong three-way group hide two of its three assertions.
 *
 * ── THE EXCEPTION-EVENT EXCLUSION, WHICH IS THE SUBTLE ONE ──
 * ADR-072 case 2: a pair whose EVENT-level `expectedOutcome` is `EXCEPTION` is
 * scored against the classification key, never the pairing key. The
 * `AMOUNT_TRUE_MISMATCH` events carry `shouldMatch: true` at pair level while
 * the event says the correct engine output is an exception — scoring them as
 * unmatched pairs understates recall, and scoring them as matches overstates it
 * and contradicts the event-level key. They are excluded from BOTH sides of
 * matching, counted in `excludedExceptionEventPairs`, and scored in §5.2.
 */

// ── The answer key, as much of it as scoring reads ────────────────────────────

export interface KeyProjection { sourceSystem: string; sourceRowNumber: number }

export interface KeyEvent {
  eventId: string;
  scenario: string;
  projections: KeyProjection[];
  expectedOutcome: 'MATCH_3WAY' | 'MATCH_2WAY' | 'EXCEPTION' | 'EXCLUDED' | 'NOISE';
  expectedCategory: string | null;
  expectedSecondaryFlags: string[];
  resolvability: 'RESOLVABLE' | 'UNRESOLVABLE';
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  requiresAlias: boolean;
}

export interface KeyPair {
  eventId: string;
  a: KeyProjection;
  b: KeyProjection;
  shouldMatch: boolean;
  viaTier: string;
}

export interface AnswerKey {
  manifest: {
    seed: number;
    fileHashes: Record<string, string>;
    theoreticalMaxMatchRatePct: number;
    unresolvableEventCount: number;
  };
  events: KeyEvent[];
  expectedPairs: KeyPair[];
  aliasKey: { variants: string[]; canonical: string; seededForEngine: boolean }[];
}

// ── What the engine produced, as fetched from the API ─────────────────────────

export interface EngineRecord { transactionId: string; sourceSystem: string; sourceRowNumber: number }

export interface EngineMatch {
  matchId: string;
  tier: string;
  status: string;
  members: { transactionId: string }[];
}

export interface EngineException {
  exceptionId: string;
  category: string;
  secondaryFlags: string[];
  /** `RecordPreview` — carries `sourceRowNumber` since ADR-073. */
  primaryRecord: EngineRecord | null;
  evidence: Record<string, unknown>;
}

export interface EngineSnapshot {
  records: EngineRecord[];
  matches: EngineMatch[];
  exceptions: EngineException[];
  /** `runs.metrics`, for the tier diagnostic and the ceiling comparison. */
  metrics: Record<string, any>;
}

/** `sourceSystem:sourceRowNumber` — the join key the answer key can express. */
export function rowKey(p: { sourceSystem: string; sourceRowNumber: number }): string {
  return `${p.sourceSystem}:${p.sourceRowNumber}`;
}

/** Order-independent key for an unordered pair of row keys. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export interface MatchingScore {
  precision: number; recall: number; f1: number;
  truePositives: number; falsePositives: number; falseNegatives: number;
  /** Pairs excluded from BOTH sides because their event is an EXCEPTION (ADR-072). */
  excludedExceptionEventPairs: number;
  /** Pairs the engine proposed but has not confirmed. Scored separately (§5.1.1). */
  pendingPairs: number;
  reviewQueuePrecision: number | null;
  /** The raw integer §5.1 insists travels with every percentage (ADR-020). */
  falsePositivePairs: { a: string; b: string }[];
}

/**
 * Every pair a set of groups asserts, with the group's status attached.
 *
 * A group is a claim about a SET of records being one economic event, so it
 * asserts every internal pair. Flattening here rather than reading the engine's
 * pair-level output is deliberate: the group is the engine's final word, and
 * S11 can refuse a pair a tier proposed (§10 rule 3).
 */
export function pairsFromMatches(
  matches: readonly EngineMatch[], byTransactionId: ReadonlyMap<string, EngineRecord>,
): Map<string, { status: string; tier: string }> {
  const out = new Map<string, { status: string; tier: string }>();
  for (const m of matches) {
    const keys = m.members
      .map((x) => byTransactionId.get(x.transactionId))
      .filter((r): r is EngineRecord => r !== undefined)
      .map(rowKey);
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        out.set(pairKey(keys[i]!, keys[j]!), { status: m.status, tier: m.tier });
      }
    }
  }
  return out;
}

/** §5.1 + §5.1.1 + ADR-072 case 2. */
export function scoreMatching(key: AnswerKey, engine: EngineSnapshot): MatchingScore {
  const byTransactionId = new Map(engine.records.map((r) => [r.transactionId, r]));
  const produced = pairsFromMatches(engine.matches, byTransactionId);

  // Events whose CORRECT engine output is an exception. Their pairs are the
  // classification key's business, not the pairing key's (ADR-072 case 2).
  const exceptionEvents = new Set(
    key.events.filter((e) => e.expectedOutcome === 'EXCEPTION').map((e) => e.eventId));

  const shouldMatch = new Set<string>();
  const shouldNotMatch = new Set<string>();
  let excluded = 0;
  for (const p of key.expectedPairs) {
    const k = pairKey(rowKey(p.a), rowKey(p.b));
    if (exceptionEvents.has(p.eventId)) { excluded += 1; continue; }
    if (p.shouldMatch) shouldMatch.add(k); else shouldNotMatch.add(k);
  }

  // Confirmed only. `pending_review` is a proposal and belongs to neither
  // bucket; `human_rejected` is a claim the engine withdrew.
  const confirmed = new Set<string>();
  const pending = new Set<string>();
  for (const [k, v] of produced) {
    if (v.status === 'auto_confirmed' || v.status === 'human_confirmed') confirmed.add(k);
    else if (v.status === 'pending_review') pending.add(k);
  }

  let tp = 0;
  const fps: { a: string; b: string }[] = [];
  for (const k of confirmed) {
    if (exceptionEvents.size > 0 && !shouldMatch.has(k) && !shouldNotMatch.has(k)) {
      // Either an exception-event pair (excluded by design, not an error) or a
      // pair the key does not mention at all. The second IS a false positive:
      // the key enumerates every pair that could legitimately match.
      const isExcludedByDesign = key.expectedPairs.some(
        (p) => pairKey(rowKey(p.a), rowKey(p.b)) === k && exceptionEvents.has(p.eventId));
      if (isExcludedByDesign) continue;
      const [a, b] = k.split('|') as [string, string];
      fps.push({ a, b });
      continue;
    }
    if (shouldMatch.has(k)) tp += 1;
    else { const [a, b] = k.split('|') as [string, string]; fps.push({ a, b }); }
  }

  const fp = fps.length;
  const fn = shouldMatch.size - tp;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = shouldMatch.size === 0 ? 0 : tp / shouldMatch.size;

  // "When this engine asks a human, is it asking about the right things?"
  let pendingCorrect = 0;
  for (const k of pending) if (shouldMatch.has(k)) pendingCorrect += 1;

  return {
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)),
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    excludedExceptionEventPairs: excluded,
    pendingPairs: pending.size,
    reviewQueuePrecision: pending.size === 0 ? null : round4(pendingCorrect / pending.size),
    falsePositivePairs: fps.sort((x, y) => (x.a + x.b < y.a + y.b ? -1 : 1)),
  };
}

export interface ClassificationScore {
  macroPrecision: number;
  macroRecall: number;
  confusionMatrix: Record<string, Record<string, number>>;
  perCategory: Record<string, { precision: number; recall: number; support: number }>;
  secondaryFlagJaccard: number | null;
  /** §5.2's two watch cells. Non-zero means S8 is not running where it should. */
  s8RegressionCells: { amountMismatchScoredAsPendingMatch: number; timingDriftAutoConfirmed: number };
}

/**
 * §5.2. Per EVENT the key says should be an exception, did the engine file the
 * right category?
 *
 * Joined at the event level, not the record level: the key's `expectedCategory`
 * is a property of the economic event, and an event's exception may be raised on
 * any of its projected rows. `NONE` is a real predicted class — an event the key
 * says should be an exception and the engine raised nothing for is a miss, and
 * folding it into "wrong category" would hide the difference between filing the
 * wrong thing and filing nothing.
 */
export function scoreClassification(
  key: AnswerKey, engine: EngineSnapshot,
): ClassificationScore {
  const byTransactionId = new Map(engine.records.map((r) => [r.transactionId, r]));
  const raisedByRow = new Map<string, EngineException>();
  for (const e of engine.exceptions) {
    if (e.primaryRecord === null) continue;
    raisedByRow.set(rowKey(e.primaryRecord), e);
  }

  const matrix: Record<string, Record<string, number>> = {};
  const bump = (expected: string, predicted: string): void => {
    matrix[expected] = matrix[expected] ?? {};
    matrix[expected]![predicted] = (matrix[expected]![predicted] ?? 0) + 1;
  };

  const jaccards: number[] = [];
  const confirmedPairs = pairsFromMatches(
    engine.matches.filter((m) => m.status === 'auto_confirmed'), byTransactionId);
  const pendingPairs = pairsFromMatches(
    engine.matches.filter((m) => m.status === 'pending_review'), byTransactionId);

  let amountMismatchScoredAsPendingMatch = 0;
  let timingDriftAutoConfirmed = 0;

  for (const ev of key.events) {
    if (ev.expectedOutcome !== 'EXCEPTION' || ev.expectedCategory === null) continue;
    const rows = ev.projections.map(rowKey);

    const raised = rows.map((r) => raisedByRow.get(r)).find((x) => x !== undefined);
    bump(ev.expectedCategory, raised?.category ?? 'NONE');

    if (raised !== undefined) {
      jaccards.push(jaccard(new Set(ev.expectedSecondaryFlags), new Set(raised.secondaryFlags)));
    }

    // §5.2's two named regressions, asserted rather than left to a reader of the
    // matrix. Both were UNREACHABLE before ADR-029 introduced S8 and are the
    // load-bearing output of that stage; if either fires, S8 is not running
    // where it should be and the matrix alone would not say so.
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const k = pairKey(rows[i]!, rows[j]!);
        // Identity was established but the pair was SCORED instead of DECIDED.
        // Scoped to a pair the key affirms, so an unrelated pending proposal
        // that happens to touch one of these rows does not fire it.
        if (ev.expectedCategory === 'AMOUNT_MISMATCH' && pendingPairs.has(k)
          && key.expectedPairs.some(
            (p) => p.shouldMatch && pairKey(rowKey(p.a), rowKey(p.b)) === k)) {
          amountMismatchScoredAsPendingMatch += 1;
        }
        // §5.2's cell is "TIMING_DRIFT predicted as auto_confirmed" — an event
        // whose CORRECT output is a TIMING_DRIFT exception that the engine
        // auto-matched instead. Keyed on `expectedCategory`, not on the
        // secondary flags: TIMING_DRIFT rides along as a secondary flag on
        // AMOUNT_MISMATCH events whose gateway<->ledger leg legitimately
        // matches, and reading the flags fired this blocker 3 times on a run
        // where nothing was wrong.
        if (ev.expectedCategory === 'TIMING_DRIFT' && confirmedPairs.has(k)) {
          timingDriftAutoConfirmed += 1;
        }
      }
    }
  }

  const categories = [...new Set([
    ...Object.keys(matrix),
    ...Object.values(matrix).flatMap((row) => Object.keys(row)),
  ])].filter((c) => c !== 'NONE').sort();

  const perCategory: Record<string, { precision: number; recall: number; support: number }> = {};
  for (const c of categories) {
    const tp = matrix[c]?.[c] ?? 0;
    const support = Object.values(matrix[c] ?? {}).reduce((a, b) => a + b, 0);
    const predicted = Object.values(matrix).reduce((sum, row) => sum + (row[c] ?? 0), 0);
    perCategory[c] = {
      precision: round4(predicted === 0 ? 0 : tp / predicted),
      recall: round4(support === 0 ? 0 : tp / support),
      support,
    };
  }

  // Macro, not micro: every category counts once regardless of how many events
  // it has. A micro average would let the two largest presence categories decide
  // the number and hide a category the engine never gets right.
  const withSupport = categories.filter((c) => perCategory[c]!.support > 0);
  const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

  return {
    macroPrecision: round4(mean(withSupport.map((c) => perCategory[c]!.precision))),
    macroRecall: round4(mean(withSupport.map((c) => perCategory[c]!.recall))),
    confusionMatrix: matrix,
    perCategory,
    secondaryFlagJaccard: jaccards.length === 0 ? null : round4(mean(jaccards)),
    s8RegressionCells: { amountMismatchScoredAsPendingMatch, timingDriftAutoConfirmed },
  };
}

export interface ResolvabilityScore {
  unresolvableDesigned: number;
  unresolvableRecall: number;
  /** Names them, because "which ones" is the only useful follow-up to a failure. */
  inventedMatchesOnUnresolvable: string[];
  falseDespairRate: number;
  falseDespairEvents: number;
  gaveUpOn: number;
  boundHonesty: { searchExhausted: number; searchBoundExceeded: number };
}

/**
 * §5.3. The two numbers that speak directly to "an honest exception list".
 *
 * `unresolvableRecall` below 1.0 is a BUILD BLOCKER, not a metric: the engine
 * has invented a match that cannot exist. It is reported with the offending
 * event ids attached so the failure is actionable in the same glance.
 */
export function scoreResolvability(key: AnswerKey, engine: EngineSnapshot): ResolvabilityScore {
  const byTransactionId = new Map(engine.records.map((r) => [r.transactionId, r]));
  const confirmed = pairsFromMatches(
    engine.matches.filter((m) => m.status === 'auto_confirmed' || m.status === 'human_confirmed'),
    byTransactionId);
  const matchedRows = new Set<string>();
  for (const k of confirmed.keys()) for (const half of k.split('|')) matchedRows.add(half);

  // "Invented a match that cannot exist" means a pair the KEY DENIES, not any
  // pair at all inside an unresolvable event.
  //
  // The first draft of this check flagged 5 events and read as a build blocker.
  // It was wrong, and wrong in the direction that makes an engine look worse:
  // §4's sub-classes are unresolvable in ONE SPECIFIC LEG, not throughout. An
  // UNSPLITTABLE_NET_BATCH event is a bank credit that nets N payments with no
  // breakup file — the credit's DECOMPOSITION is impossible, but the gateway
  // and ledger rows behind each payment are ordinary and match on payment_id.
  // The key says so itself: all three of those events' pairs carry
  // `shouldMatch: true`. Matching them is correct, and scoring it as invention
  // would penalise the engine for being right.
  //
  // So the test is: did the engine confirm a pair touching this event that the
  // key does not affirm — one marked `shouldMatch: false`, or one absent from
  // the key entirely (a cross-event pairing the key never contemplated)? That
  // generalises across all three sub-classes without naming any of them.
  const affirmed = new Set<string>();
  const denied = new Set<string>();
  for (const p of key.expectedPairs) {
    (p.shouldMatch ? affirmed : denied).add(pairKey(rowKey(p.a), rowKey(p.b)));
  }
  const eventOfRow = new Map<string, string>();
  for (const ev of key.events) for (const pr of ev.projections) eventOfRow.set(rowKey(pr), ev.eventId);

  const unresolvable = key.events.filter((e) => e.resolvability === 'UNRESOLVABLE');
  const unresolvableIds = new Set(unresolvable.map((e) => e.eventId));
  const inventedSet = new Set<string>();
  for (const k of confirmed.keys()) {
    if (affirmed.has(k)) continue;                      // the key agrees with this pair
    const [a, b] = k.split('|') as [string, string];
    for (const half of [a, b]) {
      const owner = eventOfRow.get(half);
      if (owner !== undefined && unresolvableIds.has(owner)) inventedSet.add(owner);
    }
    void denied;
  }
  const invented = [...inventedSet];

  // Events the engine gave up on: every projected row unmatched.
  const resolvable = key.events.filter((e) => e.resolvability === 'RESOLVABLE');
  let gaveUp = 0;
  let falseDespair = 0;
  for (const ev of key.events) {
    const rows = ev.projections.map(rowKey);
    if (rows.length === 0 || rows.some((r) => matchedRows.has(r))) continue;
    gaveUp += 1;
    if (ev.resolvability === 'RESOLVABLE') falseDespair += 1;
  }
  void resolvable;

  // ADR-038: "I proved no combination works" and "I ran out of budget" are
  // different claims and only one of them is a finding.
  let exhausted = 0;
  let boundExceeded = 0;
  for (const e of engine.exceptions) {
    if (e.category !== 'UNSPLITTABLE_BATCH') continue;
    if (e.evidence['searchExhausted'] === true) exhausted += 1;
    if (e.evidence['searchBoundExceeded'] !== undefined
      && e.evidence['searchBoundExceeded'] !== null
      && e.evidence['searchBoundExceeded'] !== false) boundExceeded += 1;
  }

  return {
    unresolvableDesigned: unresolvable.length,
    unresolvableRecall: round4(
      unresolvable.length === 0 ? 1 : (unresolvable.length - invented.length) / unresolvable.length),
    inventedMatchesOnUnresolvable: invented.sort(),
    falseDespairRate: round4(gaveUp === 0 ? 0 : falseDespair / gaveUp),
    falseDespairEvents: falseDespair,
    gaveUpOn: gaveUp,
    boundHonesty: { searchExhausted: exhausted, searchBoundExceeded: boundExceeded },
  };
}

/**
 * §5.4. Pair precision/recall sliced by the key's difficulty label.
 *
 * An engine at 99% on EASY and 40% on HARD has a different story from one at 85%
 * flat, and the aggregate hides it.
 */
export function scoreByDifficulty(
  key: AnswerKey, engine: EngineSnapshot,
): Record<string, { precision: number; recall: number; pairs: number }> {
  const byTransactionId = new Map(engine.records.map((r) => [r.transactionId, r]));
  const confirmed = pairsFromMatches(
    engine.matches.filter((m) => m.status === 'auto_confirmed' || m.status === 'human_confirmed'),
    byTransactionId);
  const difficultyOf = new Map(key.events.map((e) => [e.eventId, e.difficulty]));
  const exceptionEvents = new Set(
    key.events.filter((e) => e.expectedOutcome === 'EXCEPTION').map((e) => e.eventId));

  const buckets: Record<string, { tp: number; fn: number; pairs: number }> = {
    EASY: { tp: 0, fn: 0, pairs: 0 },
    MEDIUM: { tp: 0, fn: 0, pairs: 0 },
    HARD: { tp: 0, fn: 0, pairs: 0 },
  };

  for (const p of key.expectedPairs) {
    if (!p.shouldMatch || exceptionEvents.has(p.eventId)) continue;
    const d = difficultyOf.get(p.eventId);
    if (d === undefined || buckets[d] === undefined) continue;
    buckets[d]!.pairs += 1;
    if (confirmed.has(pairKey(rowKey(p.a), rowKey(p.b)))) buckets[d]!.tp += 1;
    else buckets[d]!.fn += 1;
  }

  const out: Record<string, { precision: number; recall: number; pairs: number }> = {};
  for (const [d, b] of Object.entries(buckets)) {
    // Precision is not sliceable by difficulty — a FALSE pair belongs to no
    // event, so it has no difficulty label. Reported as the recall slice it
    // actually is, rather than inventing a per-difficulty precision by
    // arbitrarily attributing false positives.
    out[d] = { precision: round4(b.pairs === 0 ? 0 : b.tp / b.pairs), recall: round4(b.pairs === 0 ? 0 : b.tp / b.pairs), pairs: b.pairs };
  }
  return out;
}

/**
 * §2.2 / ADR-072's diagnostic. NEVER an accuracy term.
 *
 * The key's `viaTier` distribution against the engine's OWN per-tier pair counts
 * from `runs.metrics.tierAttribution`. Both are pair-level and directly
 * comparable. `matches.tier` is not used and must not be: it describes a group
 * at its weakest constituent tier and disagrees with the key for most matched
 * pairs (§5.1.2).
 */
export function tierDiagnostic(
  key: AnswerKey, engine: EngineSnapshot,
): { keyViaTier: Record<string, number>; engineTierPairs: Record<string, number>; note: string } {
  const keyViaTier: Record<string, number> = {};
  for (const p of key.expectedPairs) {
    if (!p.shouldMatch) continue;
    keyViaTier[p.viaTier] = (keyViaTier[p.viaTier] ?? 0) + 1;
  }
  return {
    keyViaTier,
    engineTierPairs: (engine.metrics?.['tierAttribution'] ?? {}) as Record<string, number>,
    note:
      'DIAGNOSTIC, not an accuracy term (ADR-072). viaTier is "the weakest tier that ' +
      'should suffice"; falling through to a lower tier is not an error. These are ' +
      'compared pair-to-pair — never against matches.tier, which is a GROUP at its ' +
      'weakest constituent tier.',
  };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** ADR-032 rule 4: fixed precision before comparison, so a ratio is stable. */
export function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
