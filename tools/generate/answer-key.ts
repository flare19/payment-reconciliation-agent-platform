/**
 * The answer key (validation-strategy.md §2).
 *
 * ===========================================================================
 * A BYPRODUCT OF GENERATION, NOT AN ANNOTATION OF IT. There is no separate
 * labelling step that could disagree with the data, because the label IS what
 * the generator decided before it wrote a row. A hand-labelled key would need
 * its own validation; this one is correct by construction (§1).
 *
 * NO ENGINE-ASSIGNED IDS, EVER. The key is written before the engine has seen
 * the data, so it can only reference file-position identity —
 * `(sourceSystem, sourceRowNumber)`. A UUID appearing here would mean the key
 * had been influenced by engine behaviour, which is the one thing that would
 * make every accuracy number meaningless. A guard test scans for it.
 * ===========================================================================
 */

import { createHash } from 'node:crypto';
import { dayDelta } from '../../apps/api/src/services/ingestion/dates.js';
import { ENGINE_DEFAULTS } from '../../apps/api/src/config/defaults.js';
import type { RunConfig } from '../../apps/api/src/types/engine.js';
import type { AliasType, ExceptionCategory, PaymentMethod } from '../../apps/api/src/types/domain.js';
import type { CanonicalFacts, EconomicEvent, Merchant } from './events.js';
import { MERCHANTS } from './events.js';
import {
  SCENARIO_SPECS, type Difficulty, type ExpectedOutcome, type Resolvability,
  type Scenario, type SourceSlot,
} from './scenarios.js';
import type { DefectCode, ProjectedRow } from './projection.js';
import type { IdentityCluster } from './planting.js';

/** The generator's own version. Bumped when a change alters emitted bytes. */
export const GENERATOR_VERSION = '1.0.0';

/** The weakest tier that should suffice for a pair (§2.2). `manual` never appears: the key expects no human. */
export type ExpectedTier = 'exact' | 'alias' | 'fuzzy' | 'batch';

export interface RowRef { sourceSystem: SourceSlot; sourceRowNumber: number }

export interface KeyProjection extends RowRef { defects: readonly DefectCode[] }

export interface KeyEvent {
  eventId: string;
  scenario: Scenario;
  canonical: CanonicalFacts;
  projections: readonly KeyProjection[];
  expectedOutcome: ExpectedOutcome;
  expectedCategory: ExceptionCategory | null;
  expectedSecondaryFlags: readonly ExceptionCategory[];
  resolvability: Resolvability;
  difficulty: Difficulty;
  requiresAlias: boolean;
  notes: string;
}

export interface ExpectedPair {
  eventId: string;
  a: RowRef;
  b: RowRef;
  shouldMatch: boolean;
  viaTier: ExpectedTier;
}

export interface AliasKeyEntry {
  aliasType: AliasType;
  variants: readonly string[];
  canonical: string;
  /** False marks a HELD-OUT variant, so alias learning can be measured cold (§6). */
  seededForEngine: boolean;
  affectedEventIds: readonly string[];
}

export interface Manifest {
  seed: number;
  generatorVersion: string;
  /**
   * NO GENERATION TIMESTAMP, deliberately, and this contradicts §2.4's field list.
   * §1 requires "same seed → byte-identical files and key"; a timestamp breaks
   * that on every regeneration and changes the key's own content hash, so the
   * artifact could never be compared to itself. `seed` and `generatorVersion`
   * identify it completely and reproducibly, and git records when it was written.
   */
  recordCounts: Readonly<Record<SourceSlot, number>>;
  eventCount: number;
  realizedDistribution: Readonly<Record<Scenario, number>>;
  /** sha256 of each emitted file. The scorer refuses to run if these disagree (§2.4). */
  fileHashes: Readonly<Record<SourceSlot, string>>;
  unresolvableEventCount: number;
  /** Computed from the realized data, never asserted. The number every other number is reported against. */
  theoreticalMaxMatchRatePct: number;
}

export interface AnswerKey {
  manifest: Manifest;
  events: readonly KeyEvent[];
  expectedPairs: readonly ExpectedPair[];
  aliasKey: readonly AliasKeyEntry[];
}

/** A projected row plus the file position it was written at. */
export interface EmittedRow { row: ProjectedRow; sourceRowNumber: number }

export interface AnswerKeyInput {
  seed: number;
  events: readonly EconomicEvent[];
  realizedDistribution: Readonly<Record<Scenario, number>>;
  emitted: readonly EmittedRow[];
  identityClusters: readonly IdentityCluster[];
  /** Raw file bytes, for the content hashes. */
  files: Readonly<Record<SourceSlot, string>>;
  /** Variants the alias table is pre-populated with. Empty means a fully cold run (ADR-020). */
  seededVariants?: ReadonlySet<string>;
  merchants?: readonly Merchant[];
  config?: RunConfig;
}

const DEFECTS_DESTROYING_AN_ANCHOR: readonly DefectCode[] = ['REF_MISSING', 'REF_TYPO', 'DESC_TRUNCATED'];

const hasAnchorDamage = (row: ProjectedRow): boolean =>
  row.defects.some((d) => DEFECTS_DESTROYING_AN_ANCHOR.includes(d));

/**
 * The weakest tier that should suffice for a pair.
 *
 * COMPUTED FROM THE REALIZED PROJECTION, not looked up per scenario, because it
 * is a property of which anchors actually survived on THESE two rows. §2.2 wants
 * it so scoring can report tier-level correctness: falling through to fuzzy is
 * not wrong, but a system that matches everything by fuzzy is more fragile than
 * the same match rate earned at exact, and this is what makes that visible.
 *
 * The shared anchor differs per source pair, and that is the whole rule:
 *   gateway↔ledger  payment_id ↔ gateway_ref
 *   gateway↔bank    rrn or settlement_id, embedded in the description blob
 *   bank↔ledger     NOTHING is shared directly, so it can never be exact
 */
export function weakestSufficientTier(a: ProjectedRow, b: ProjectedRow, requiresAlias: boolean): ExpectedTier {
  const pair = [a.sourceSystem, b.sourceSystem].sort().join('-');
  const anchorSurvives = pair !== 'bank-ledger' && !hasAnchorDamage(a) && !hasAnchorDamage(b);
  if (anchorSurvives) return 'exact';
  // Only once identity has to be re-established does a merchant variant start
  // doing work — with a payment_id in hand the engine never consults an alias.
  return requiresAlias ? 'alias' : 'fuzzy';
}

/** Every unordered pair of distinct sources among an event's rows. */
function pairsOf(rows: readonly EmittedRow[]): [EmittedRow, EmittedRow][] {
  const out: [EmittedRow, EmittedRow][] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (rows[i]!.row.sourceSystem !== rows[j]!.row.sourceSystem) out.push([rows[i]!, rows[j]!]);
    }
  }
  return out;
}

const ref = (e: EmittedRow): RowRef =>
  ({ sourceSystem: e.row.sourceSystem, sourceRowNumber: e.sourceRowNumber });

const dateOf = (row: ProjectedRow): string =>
  row.sourceSystem === 'gateway' ? row.createdAt.slice(0, 10)
    : row.sourceSystem === 'bank' ? row.valueDate : row.entryDate;

const windowFor = (method: PaymentMethod, config: RunConfig): readonly [number, number] =>
  method === 'upi' ? config.dateWindowUpiDays : config.dateWindowCardDays;

/**
 * Secondary flags, derived — and deliberately only `TIMING_DRIFT`.
 *
 * A flag the key asserts wrongly scores a correct classifier as wrong, so this
 * emits only the one flag that follows from the data without guessing at the
 * classifier's realized precedence: identity established, amount agreeing, and
 * the settlement outside the engine's own window for that method. §5.2 scores the
 * PRIMARY category; the rest of the flags are left for a later pass rather than
 * asserted on a hunch.
 */
function secondaryFlags(
  event: EconomicEvent, rows: readonly EmittedRow[], config: RunConfig,
): ExceptionCategory[] {
  const gateway = rows.find((e) => e.row.sourceSystem === 'gateway');
  const bank = rows.find((e) => e.row.sourceSystem === 'bank');
  if (gateway === undefined || bank === undefined) return [];
  if (hasAnchorDamage(gateway.row) || hasAnchorDamage(bank.row)) return [];
  const [lo, hi] = windowFor(event.canonical.method, config);
  const lag = dayDelta(dateOf(gateway.row), dateOf(bank.row));
  return lag < lo || lag > hi ? ['TIMING_DRIFT'] : [];
}

export function buildAnswerKey(input: AnswerKeyInput): AnswerKey {
  const {
    seed, events, realizedDistribution, emitted, identityClusters, files,
    seededVariants = new Set<string>(), merchants = MERCHANTS,
    config = { ...ENGINE_DEFAULTS, referenceDate: '2026-08-20', aliasCountAtStart: 0 },
  } = input;

  const byEvent = new Map<string, EmittedRow[]>();
  for (const e of emitted) {
    if (e.row.eventId === null) continue;
    const list = byEvent.get(e.row.eventId) ?? [];
    list.push(e);
    byEvent.set(e.row.eventId, list);
  }

  const keyEvents: KeyEvent[] = [];
  const expectedPairs: ExpectedPair[] = [];

  for (const event of events) {
    const spec = SCENARIO_SPECS[event.scenario];
    const rows = (byEvent.get(event.eventId) ?? [])
      .sort((x, y) => x.sourceRowNumber - y.sourceRowNumber);

    // REF_MISSING_OR_TYPO degrades a pair's tier; it must not degrade the EVENT
    // into an ambiguous one. A version of it with every anchor destroyed is
    // IDENTITY_DESTROYED under another name, and silently converting one scenario
    // into another makes the §3 weights — and the ceiling derived from them — a
    // description of something the dataset is not.
    if (event.scenario === 'REF_MISSING_OR_TYPO' && rows.length > 0 && rows.every((r) => hasAnchorDamage(r.row))) {
      throw new Error(
        `buildAnswerKey: ${event.eventId} is REF_MISSING_OR_TYPO with every anchor destroyed, which is ` +
        `IDENTITY_DESTROYED by another name. Leave at least one pair an anchor, or reweight §3.`);
    }

    keyEvents.push({
      eventId: event.eventId,
      scenario: event.scenario,
      canonical: event.canonical,
      projections: rows.map((e) => ({ ...ref(e), defects: e.row.defects })),
      expectedOutcome: spec.outcome,
      expectedCategory: spec.category,
      expectedSecondaryFlags: secondaryFlags(event, rows, config),
      resolvability: spec.resolvability,
      difficulty: spec.difficulty,
      requiresAlias: spec.requiresAlias,
      notes: spec.notes,
    });

    for (const [a, b] of pairsOf(rows)) {
      expectedPairs.push({
        eventId: event.eventId,
        a: ref(a), b: ref(b),
        shouldMatch: true,
        viaTier: event.scenario === 'UNSPLITTABLE_NET_BATCH' || event.scenario === 'SPLIT_SETTLEMENT'
          ? 'batch' : weakestSufficientTier(a.row, b.row, spec.requiresAlias),
      });
    }
  }

  // ─── negative pairs, only where a wrong match is DESIGNED to be tempting ───
  // Emitting every non-matching pair would be O(n²) — 850 rows is 360k entries —
  // and the scorer treats any matched pair absent from the key as a false
  // positive anyway. What is worth stating explicitly is the handful of pairs the
  // engine is most likely to guess at: the identity clusters exist precisely to
  // be indistinguishable, so a match between two members is THE false positive
  // the ~93% ceiling depends on not happening.
  for (const cluster of identityClusters) {
    const members = cluster.eventIds
      .map((id) => (byEvent.get(id) ?? []).filter((e) => e.row.sourceSystem === 'gateway'))
      .flat();
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        expectedPairs.push({
          eventId: members[i]!.row.eventId!,
          a: ref(members[i]!), b: ref(members[j]!),
          shouldMatch: false, viaTier: 'fuzzy',
        });
      }
    }
  }

  // ─── alias key (§2.3) ─────────────────────────────────────────────────────
  const usedVariants = new Map<string, Set<string>>();
  for (const e of emitted) {
    const name = e.row.sourceSystem === 'gateway' ? e.row.merchantName
      : e.row.sourceSystem === 'ledger' ? e.row.customerName : null;
    if (name === null || e.row.eventId === null) continue;
    const set = usedVariants.get(name) ?? new Set<string>();
    set.add(e.row.eventId);
    usedVariants.set(name, set);
  }

  const aliasKey: AliasKeyEntry[] = [];
  for (const merchant of merchants) {
    const variants = merchant.variants.filter((v) => usedVariants.has(v));
    if (variants.length === 0) continue;
    const affected = new Set<string>();
    for (const v of variants) for (const id of usedVariants.get(v)!) affected.add(id);
    aliasKey.push({
      aliasType: 'merchant_name',
      variants,
      canonical: merchant.canonical,
      seededForEngine: variants.every((v) => seededVariants.has(v)),
      affectedEventIds: [...affected].sort(),
    });
  }

  // ─── manifest (§2.4) ──────────────────────────────────────────────────────
  const recordCounts = { gateway: 0, bank: 0, ledger: 0 };
  for (const e of emitted) recordCounts[e.row.sourceSystem] += 1;

  const unresolvable = events.filter((e) => SCENARIO_SPECS[e.scenario].resolvability === 'UNRESOLVABLE').length;

  return {
    manifest: {
      seed,
      generatorVersion: GENERATOR_VERSION,
      recordCounts,
      eventCount: events.length,
      realizedDistribution,
      fileHashes: {
        gateway: sha256(files.gateway),
        bank: sha256(files.bank),
        ledger: sha256(files.ledger),
      },
      unresolvableEventCount: unresolvable,
      theoreticalMaxMatchRatePct: events.length === 0 ? 0
        : Math.round((1 - unresolvable / events.length) * 1000) / 10,
    },
    events: keyEvents,
    expectedPairs,
    aliasKey,
  };
}

export function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** Stable, diffable JSON. Two runs of the same seed must produce identical bytes. */
export function serializeAnswerKey(key: AnswerKey): string {
  return `${JSON.stringify(key, null, 2)}\n`;
}
