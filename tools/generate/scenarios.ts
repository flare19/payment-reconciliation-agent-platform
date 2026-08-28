/**
 * The scenario taxonomy and its distribution (validation-strategy.md §3, §4).
 *
 * ONE VOCABULARY, SHARED WITH THE ENGINE. `ExceptionCategory` is imported from
 * `apps/api/src/types/domain.ts` rather than restated here. A second copy of the
 * taxonomy in the generator would compile, agree on the day it was written, and
 * drift the first time a category is renamed — after which the scorer would be
 * comparing the engine's answers against a key written in a slightly different
 * language, and every classification number would be wrong in a way no test
 * could see. The engine never imports FROM here (ADR-021); this direction is
 * safe and is the one that keeps the two in step.
 */

import type { ExceptionCategory } from '../../apps/api/src/types/domain.js';

export type Scenario =
  | 'CLEAN_3WAY' | 'TIMING_LAG_NORMAL' | 'FEE_NET_SETTLEMENT' | 'MERCHANT_NAME_VARIANT'
  | 'REF_MISSING_OR_TYPO' | 'MISSING_IN_LEDGER' | 'MISSING_IN_BANK'
  | 'AMOUNT_TRUE_MISMATCH' | 'DUPLICATE_ROW' | 'SPLIT_SETTLEMENT' | 'REFUND_REVERSAL'
  // §4's unresolvable family, flattened. The three sub-classes are scenarios in
  // their own right rather than a nested draw: they fail for structurally
  // different reasons, they carry different expected categories, and flattening
  // means one allocation pass decides all fourteen counts.
  | 'IDENTITY_DESTROYED' | 'ORPHAN_NO_COUNTERPART' | 'UNSPLITTABLE_NET_BATCH';

export type ExpectedOutcome = 'MATCH_3WAY' | 'MATCH_2WAY' | 'EXCEPTION' | 'EXCLUDED' | 'NOISE';
export type Resolvability = 'RESOLVABLE' | 'UNRESOLVABLE';
export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type SourceSlot = 'gateway' | 'bank' | 'ledger';

export interface ScenarioSpec {
  /** Relative weight, as the percentages §3 is written in. */
  weight: number;
  /** Which sources this event appears in at all (defects may still degrade them). */
  sources: readonly SourceSlot[];
  outcome: ExpectedOutcome;
  /** `null` when the event is expected to match cleanly and raise nothing. */
  category: ExceptionCategory | null;
  resolvability: Resolvability;
  difficulty: Difficulty;
  requiresAlias: boolean;
  /**
   * True when the realized projection decides the outcome, so the answer key
   * must compute it rather than copy it from this table.
   */
  outcomeDependsOnProjection: boolean;
  notes: string;
}

/**
 * §3's table, verbatim, with the 7% unresolvable family split by §4's shares
 * (40/30/30 → 2.8 / 2.1 / 2.1). Sums to 100.
 *
 * These are the shipped defaults and the generator takes them as config, so the
 * mix can be tuned without touching logic.
 */
export const SCENARIO_SPECS: Readonly<Record<Scenario, ScenarioSpec>> = {
  CLEAN_3WAY: {
    weight: 36, sources: ['gateway', 'bank', 'ledger'],
    outcome: 'MATCH_3WAY', category: null, resolvability: 'RESOLVABLE',
    difficulty: 'EASY', requiresAlias: false, outcomeDependsOnProjection: false,
    notes: 'Matches at exact on the shared payment reference.',
  },
  TIMING_LAG_NORMAL: {
    weight: 10, sources: ['gateway', 'bank', 'ledger'],
    outcome: 'MATCH_3WAY', category: null, resolvability: 'RESOLVABLE',
    difficulty: 'EASY', requiresAlias: false, outcomeDependsOnProjection: false,
    notes: 'Settlement lands inside the declared window; a match, not a drift exception.',
  },
  FEE_NET_SETTLEMENT: {
    weight: 10, sources: ['gateway', 'bank', 'ledger'],
    outcome: 'MATCH_3WAY', category: null, resolvability: 'RESOLVABLE',
    difficulty: 'MEDIUM', requiresAlias: false, outcomeDependsOnProjection: false,
    notes: 'Bank credit is net of fee and GST; resolved by the net-amount rule, not by tolerance.',
  },
  MERCHANT_NAME_VARIANT: {
    weight: 8, sources: ['gateway', 'bank', 'ledger'],
    outcome: 'MATCH_3WAY', category: null, resolvability: 'RESOLVABLE',
    difficulty: 'MEDIUM', requiresAlias: true, outcomeDependsOnProjection: false,
    notes: 'Same merchant, different string per source. Cold: fuzzy. Warm: alias tier.',
  },
  REF_MISSING_OR_TYPO: {
    weight: 6, sources: ['gateway', 'bank', 'ledger'],
    outcome: 'MATCH_3WAY', category: null, resolvability: 'RESOLVABLE',
    difficulty: 'HARD', requiresAlias: false, outcomeDependsOnProjection: true,
    notes: 'Matches at fuzzy while an anchor survives; degrades to an exception when none does.',
  },
  MISSING_IN_LEDGER: {
    weight: 5, sources: ['gateway', 'bank'],
    outcome: 'EXCEPTION', category: 'MISSING_IN_LEDGER', resolvability: 'RESOLVABLE',
    difficulty: 'EASY', requiresAlias: false, outcomeDependsOnProjection: false,
    notes: 'Gateway and bank should still pair; the absent ledger leg is the exception.',
  },
  MISSING_IN_BANK: {
    weight: 5, sources: ['gateway', 'ledger'],
    outcome: 'EXCEPTION', category: 'MISSING_IN_BANK', resolvability: 'RESOLVABLE',
    difficulty: 'EASY', requiresAlias: false, outcomeDependsOnProjection: false,
    notes: 'Gateway and ledger should still pair; the absent bank leg is the exception.',
  },
  AMOUNT_TRUE_MISMATCH: {
    weight: 4, sources: ['gateway', 'bank', 'ledger'],
    outcome: 'EXCEPTION', category: 'AMOUNT_MISMATCH', resolvability: 'RESOLVABLE',
    difficulty: 'MEDIUM', requiresAlias: false, outcomeDependsOnProjection: false,
    notes: 'Identity established, amounts genuinely disagree beyond any tolerance.',
  },
  DUPLICATE_ROW: {
    weight: 3, sources: ['gateway', 'bank', 'ledger'],
    outcome: 'EXCEPTION', category: 'DUPLICATE_RECORD', resolvability: 'RESOLVABLE',
    difficulty: 'EASY', requiresAlias: false, outcomeDependsOnProjection: false,
    notes: 'Retry artifact: one source emits the event twice, carrying the SAME strong anchor (ADR-034).',
  },
  SPLIT_SETTLEMENT: {
    weight: 3, sources: ['gateway', 'bank', 'ledger'],
    outcome: 'MATCH_3WAY', category: null, resolvability: 'RESOLVABLE',
    difficulty: 'HARD', requiresAlias: false, outcomeDependsOnProjection: false,
    notes: 'One gateway payment settled across 2-4 bank credits; one_to_many.',
  },
  REFUND_REVERSAL: {
    weight: 3, sources: ['gateway', 'bank', 'ledger'],
    outcome: 'MATCH_3WAY', category: null, resolvability: 'RESOLVABLE',
    difficulty: 'MEDIUM', requiresAlias: false, outcomeDependsOnProjection: false,
    notes: 'Refunded gateway row against a bank DEBIT. Exercises the direction gate (ADR-035).',
  },
  IDENTITY_DESTROYED: {
    weight: 2.8, sources: ['gateway', 'bank', 'ledger'],
    outcome: 'EXCEPTION', category: 'AMBIGUOUS_MATCH', resolvability: 'UNRESOLVABLE',
    difficulty: 'HARD', requiresAlias: false, outcomeDependsOnProjection: false,
    notes: 'Every anchor destroyed and 3+ indistinguishable candidates planted. Proven, not labelled (§4).',
  },
  ORPHAN_NO_COUNTERPART: {
    weight: 2.1, sources: ['bank'],
    outcome: 'EXCEPTION', category: 'MISSING_IN_GATEWAY', resolvability: 'UNRESOLVABLE',
    difficulty: 'HARD', requiresAlias: false, outcomeDependsOnProjection: false,
    notes: 'A bank row with no economic event behind it — chargeback reversal, fee debit, stray transfer.',
  },
  UNSPLITTABLE_NET_BATCH: {
    weight: 2.1, sources: ['gateway', 'bank', 'ledger'],
    outcome: 'EXCEPTION', category: 'UNSPLITTABLE_BATCH', resolvability: 'UNRESOLVABLE',
    difficulty: 'HARD', requiresAlias: false, outcomeDependsOnProjection: false,
    notes: 'One bank credit nets N payments with no breakup file, and no subset sums into it (§4).',
  },
};

export const SCENARIOS = Object.keys(SCENARIO_SPECS) as readonly Scenario[];

/**
 * ORPHAN_NO_COUNTERPART is modelled as an event with a single bank projection and
 * no economic counterpart, which is a deliberate fiction: §4 defines it as a row
 * with *no* event behind it. The answer key still needs a per-row expectation
 * saying this row should surface as MISSING_IN_GATEWAY, and an event with one
 * projection is the least confusing container for that. §4's proof — "assert no
 * event references the row" — therefore reads: no OTHER event projects onto it.
 */
export const HAS_NO_ECONOMIC_COUNTERPART: Scenario = 'ORPHAN_NO_COUNTERPART';

/**
 * Split `total` events across the scenarios by weight, using LARGEST REMAINDER.
 *
 * Not independent weighted draws, and the difference matters. §3 says realized
 * counts "drift a little from the targets" — but independent draws on 300 events
 * at a 3% weight have a standard deviation near 3, so a 9-event scenario lands
 * anywhere from 3 to 15. That is not "a little", and it would make the published
 * figures seed-dependent: §4 argues for 7% *specifically* because ~21 events is
 * "large enough to be statistically real and to break down into three sub-classes
 * with meaningful counts each", and the ~93% ceiling that appears in the README,
 * the UI and the pitch is computed from that count. Under sampling variance those
 * numbers would change every time the seed changed, and every doc quoting them
 * would go stale on regeneration.
 *
 * Largest remainder keeps every count within one of its target, so the realized
 * distribution is still reported (§3) and still differs from the ideal — by
 * rounding rather than by chance. WHICH events are unresolvable still varies
 * freely with the seed; only HOW MANY is stable.
 *
 * Consumes no randomness, deliberately: allocation must not shift the stream that
 * generates the events themselves.
 */
export function allocateScenarios(
  total: number,
  specs: Readonly<Record<Scenario, ScenarioSpec>> = SCENARIO_SPECS,
): Map<Scenario, number> {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error(`allocateScenarios: total must be a non-negative integer, got ${total}`);
  }
  const entries = (Object.keys(specs) as Scenario[]).map((s) => ({ scenario: s, weight: specs[s].weight }));
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  if (totalWeight <= 0) throw new Error('allocateScenarios: total weight is zero');

  const exact = entries.map((e) => ({ ...e, ideal: (total * e.weight) / totalWeight }));
  const counts = new Map<Scenario, number>(exact.map((e) => [e.scenario, Math.floor(e.ideal)]));
  let remaining = total - [...counts.values()].reduce((a, b) => a + b, 0);

  // Descending fractional part; ties broken by DECLARATION ORDER, so the result is
  // a pure function of (total, specs) with no hidden dependence on key iteration.
  const byRemainder = exact
    .map((e, index) => ({ scenario: e.scenario, frac: e.ideal - Math.floor(e.ideal), index }))
    .sort((a, b) => (b.frac - a.frac) || (a.index - b.index));

  for (let i = 0; remaining > 0; i += 1, remaining -= 1) {
    const pick = byRemainder[i % byRemainder.length]!;
    counts.set(pick.scenario, counts.get(pick.scenario)! + 1);
  }
  return counts;
}
