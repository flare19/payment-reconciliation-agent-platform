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
  /**
   * Present on `ExceptionDetail` (endpoint 7), ABSENT on `ExceptionSummary`
   * (endpoint 6, which this scorer walks). Optional so the type says so.
   */
  evidence?: Record<string, unknown>;
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

/**
 * `schema.md` §8.2's precedence, verbatim. The engine applies it per RECORD to
 * choose one primary category; the scorer applies it across an EVENT's records
 * to choose which of several raised categories is that event's prediction (#50).
 *
 * Using the engine's own stated rule is what makes the choice principled rather
 * than arbitrary. It does not consult the expected category, so it cannot
 * manufacture a true positive; and §8.2 names this exact case — *"Unsplittable
 * batch before presence… its member payments would each otherwise be reported as
 * `MISSING_IN_BANK`, turning one honest exception into five misleading ones."*
 * Canonical row order got that backwards, reporting 0.000 for a category the
 * engine raises on exactly the right credits.
 */
export const CATEGORY_PRECEDENCE: readonly string[] = [
  'DUPLICATE_RECORD',
  'AMBIGUOUS_MATCH',
  'UNSPLITTABLE_BATCH',
  'AMOUNT_MISMATCH',
  'MISSING_IN_GATEWAY',
  'MISSING_IN_BANK',
  'MISSING_IN_LEDGER',
  'TIMING_DRIFT',
];

function precedenceOf(category: string): number {
  const i = CATEGORY_PRECEDENCE.indexOf(category);
  return i === -1 ? CATEGORY_PRECEDENCE.length : i;
}

/** Canonical order over row keys: gateway < bank < ledger, then row number. */
export function compareRowKeys(a: string, b: string): number {
  const rank = (k: string): number =>
    ({ gateway: 0, bank: 1, ledger: 2 }[k.split(':')[0] ?? ''] ?? 3);
  const r = rank(a) - rank(b);
  if (r !== 0) return r;
  return Number(a.split(':')[1] ?? 0) - Number(b.split(':')[1] ?? 0);
}

/** `gateway:12|gateway:44` — both halves from the same source file. */
export function isSameSource(k: string): boolean {
  const [a, b] = k.split('|') as [string, string];
  return a.split(':')[0] === b.split(':')[0];
}

/**
 * Is a same-source pair the engine produced something the key can judge?
 *
 * The key models CROSS-SOURCE pairs. Its only same-source entries are the nine
 * `IDENTITY_DESTROYED` gateway↔gateway DENIALS — the case where three
 * indistinguishable rows are planted and matching any two of them is the single
 * most damning failure available. Those must stay scoreable, and stay false
 * positives.
 *
 * Every other same-source pair comes from a legitimate `one_to_many` /
 * `many_to_one` group: two bank legs of one split settlement are both members of
 * one economic event, and the key never enumerates that relationship because it
 * is not a claim that the two rows are each other's counterpart. `scorePair`'s
 * `GATE_SAME_SOURCE_V1` means such a pair can only ever arise from a cardinality
 * rule, never from a similarity score, so there is no way for a wrong match to
 * hide here.
 *
 * Scoring them as false positives would have penalised the engine for the exact
 * shape §8.1 exists to produce — it appeared the moment S10's splits started
 * forming groups (#46/#49), and it is a defect in the SCORER, not the engine.
 */
export function isJudgeableSameSourcePair(key: AnswerKey, k: string): boolean {
  return key.expectedPairs.some(
    (p) => p.a.sourceSystem === p.b.sourceSystem
      && pairKey(rowKey(p.a), rowKey(p.b)) === k);
}

export interface MatchingScore {
  precision: number; recall: number; f1: number;
  truePositives: number; falsePositives: number; falseNegatives: number;
  /** Pairs excluded from BOTH sides because their event is an EXCEPTION (ADR-072). */
  excludedExceptionEventPairs: number;
  /**
   * Same-source legs of a `one_to_many` / `many_to_one` group, which the key does
   * not model. Excluded and COUNTED, never silently dropped.
   */
  excludedSameSourceLegs: number;
  /** Pairs the engine proposed but has not confirmed. Scored separately (§5.1.1). */
  pendingPairs: number;
  /** Pending pairs the pairing key does not judge — same exclusions as TP/FP. */
  pendingExcludedFromQueuePrecision: number;
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
  let excludedSameSourceLegs = 0;
  const fps: { a: string; b: string }[] = [];
  for (const k of confirmed) {
    // A same-source pair the key does not mention is a cardinality leg, not a
    // counterpart claim. One the key DENIES stays fully scoreable.
    if (isSameSource(k) && !isJudgeableSameSourcePair(key, k)) {
      excludedSameSourceLegs += 1;
      continue;
    }
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
  //
  // The SAME exclusions as the primary metric, or the two disagree about what
  // counts as a wrong question. A pending pair on an EXCEPTION event (ADR-072)
  // is not a bad proposal — it is a pair the pairing key does not judge — and a
  // same-source cardinality leg is not a proposal at all. Counting either as
  // incorrect reported 24 "wrong" proposals on a run whose genuinely wrong count
  // is zero, and dragged the queue's precision from 1.0 to 0.88.
  let pendingCorrect = 0;
  let pendingExcluded = 0;
  for (const k of pending) {
    if (isSameSource(k) && !isJudgeableSameSourcePair(key, k)) { pendingExcluded += 1; continue; }
    if (shouldMatch.has(k)) { pendingCorrect += 1; continue; }
    if (shouldNotMatch.has(k)) continue;                       // a genuinely wrong ask
    const onExceptionEvent = key.expectedPairs.some(
      (p) => pairKey(rowKey(p.a), rowKey(p.b)) === k && exceptionEvents.has(p.eventId));
    if (onExceptionEvent) pendingExcluded += 1;
  }
  const pendingJudged = pending.size - pendingExcluded;

  return {
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)),
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    excludedExceptionEventPairs: excluded,
    excludedSameSourceLegs,
    pendingPairs: pending.size,
    pendingExcludedFromQueuePrecision: pendingExcluded,
    reviewQueuePrecision: pendingJudged === 0 ? null : round4(pendingCorrect / pendingJudged),
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
  /**
   * Exception events where the engine raised MORE THAN ONE category across the
   * event's rows. The key names one, so exactly one of them is scored and the
   * rest are invisible — this counts how often that reduction happened, so the
   * confusion matrix is read knowing how much it is flattening.
   */
  multiCategoryEvents: number;
  /**
   * The same events scored WITHOUT the single-label reduction (#50): a category
   * counts if the engine raised it anywhere on the event. Reported beside the
   * matrix, never instead of it — a set-valued prediction and a primary-category
   * prediction answer different questions, and collapsing them would hide which
   * one a figure came from.
   */
  multiLabel: {
    anyCategoryRecall: number;
    perCategory: Record<string, { precision: number; recall: number }>;
  };
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
  let multiCategoryEvents = 0;
  let multiLabelHits = 0;
  let multiLabelEvents = 0;
  const multiRaised = new Map<string, number>();
  const multiCorrect = new Map<string, number>();

  for (const ev of key.events) {
    if (ev.expectedOutcome !== 'EXCEPTION' || ev.expectedCategory === null) continue;
    const rows = ev.projections.map(rowKey);

    // An event can carry several exceptions — a net batch raises
    // UNSPLITTABLE_BATCH on the credit AND MISSING_IN_BANK on the gateway and
    // ledger rows, and all three are true. The key names ONE expectedCategory,
    // so one prediction must be chosen, by a STATED rule (ADR-032 rule 3).
    //
    // The rule is the engine's own precedence (§8.2), applied across the event's
    // records. Row order was the first attempt and it is backwards for exactly
    // the case §8.2 legislates: the gateway row is reached first, carries
    // MISSING_IN_BANK, and the batch verdict is never scored.
    const onEvent = [...rows]
      .sort(compareRowKeys)
      .map((r) => raisedByRow.get(r))
      .filter((x): x is EngineException => x !== undefined);
    const raised = [...onEvent].sort(
      (x, y) => precedenceOf(x.category) - precedenceOf(y.category))[0];
    bump(ev.expectedCategory, raised?.category ?? 'NONE');
    if (onEvent.length > 1) multiCategoryEvents += 1;

    // Multi-label view, reported alongside (#50). The single-label matrix throws
    // away everything the engine said after its highest-precedence verdict, and
    // on this dataset that is more than half the exception events. Recall asks
    // "did the engine say the right thing ANYWHERE on this event"; precision is
    // computed per category below over the events that raised it, so an engine
    // that raises everything everywhere scores ~1/8 and is caught.
    const categories = new Set(onEvent.map((x) => x.category));
    if (categories.has(ev.expectedCategory)) multiLabelHits += 1;
    multiLabelEvents += 1;
    for (const c of categories) {
      multiRaised.set(c, (multiRaised.get(c) ?? 0) + 1);
      if (c === ev.expectedCategory) multiCorrect.set(c, (multiCorrect.get(c) ?? 0) + 1);
    }

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
    multiCategoryEvents,
    multiLabel: {
      anyCategoryRecall: round4(multiLabelEvents === 0 ? 0 : multiLabelHits / multiLabelEvents),
      perCategory: Object.fromEntries([...multiRaised.keys()].sort().map((c) => {
        const support = Object.values(matrix[c] ?? {}).reduce((a, b) => a + b, 0);
        return [c, {
          precision: round4((multiRaised.get(c) ?? 0) === 0
            ? 0 : (multiCorrect.get(c) ?? 0) / multiRaised.get(c)!),
          recall: round4(support === 0 ? 0 : (multiCorrect.get(c) ?? 0) / support),
        }];
      })),
    },
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
    // A cardinality leg is not an invented match — see `isJudgeableSameSourcePair`.
    if (isSameSource(k) && !isJudgeableSameSourcePair(key, k)) continue;
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
  //
  // Read from `runs.metrics`, NOT from exception evidence. `ExceptionSummary`
  // (endpoint 6, the list this scorer walks) deliberately does not carry
  // `evidence` — only `ExceptionDetail` (endpoint 7) does. The original code
  // read `e.evidence['searchExhausted']` and never crashed only because S10 was
  // unwired and the `UNSPLITTABLE_BATCH` guard above always skipped: the first
  // run that produced one threw `Cannot read properties of undefined`.
  //
  // S14 already computes both counts from the verdicts themselves, which is a
  // better source than re-deriving them from a serialised subset — and it means
  // the scorer and the engine cannot disagree about what the search concluded.
  const batchStats = (engine.metrics?.['exceptions'] ?? {}) as Record<string, unknown>;
  const asCount = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const exhausted = asCount(batchStats['batchSearchExhausted']);
  const boundExceeded = asCount(batchStats['batchSearchBoundExceeded']);

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
