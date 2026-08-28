/**
 * Phase 1 — the economic events (validation-strategy.md §1).
 *
 * An economic event is a real thing that happened: "customer paid ₹1,234.50 to
 * Amazon Retail on 14 Aug 2026 by card." It is the ground truth, and everything
 * downstream — the messy source rows, the answer key, every accuracy number — is
 * derived from it. Nothing here knows about CSV, defects or file formats.
 *
 * The data is SYNTHETIC. Merchant names are recognisable Indian brands so a
 * panelist can read the dataset at a glance; no row corresponds to a real
 * transaction, and none is presented as one.
 */

import type { Direction, PaymentMethod } from '../../apps/api/src/types/domain.js';
import { addDays } from '../../apps/api/src/services/ingestion/dates.js';
import type { Rng } from './prng.js';
import { allocateScenarios, SCENARIO_SPECS, type Scenario, type ScenarioSpec } from './scenarios.js';

/** What actually happened. The answer key's `canonical` block (§2.1). */
export interface CanonicalFacts {
  amountPaise: number;
  /** IST business date, `YYYY-MM-DD`. */
  date: string;
  /** Canonical merchant name — the one a learned alias resolves variants TO. */
  merchant: string;
  method: PaymentMethod;
  /**
   * NOT shown in §2.1's example, which is a card capture, but a canonical fact of
   * the event all the same: REFUND_REVERSAL is a debit and the direction gate
   * (ADR-035) is what the scenario exists to exercise. A key that omitted it
   * could not state what the refund's correct outcome was.
   */
  direction: Direction;
}

export interface EconomicEvent {
  /** Stable across regenerations of the same seed. */
  eventId: string;
  scenario: Scenario;
  canonical: CanonicalFacts;
}

export interface Merchant {
  /** What the alias table resolves TO. */
  canonical: string;
  /**
   * How this merchant's name appears in systems that record it differently.
   * A property of the merchant, not of a defect — the defect stage chooses
   * WHETHER to use a variant; which strings exist is a fact about the brand.
   * Also what the answer key's `aliasKey` (§2.3) is built from.
   */
  variants: readonly string[];
}

/**
 * Fourteen merchants. Enough that same-merchant collisions occur naturally across
 * a 30-day window, few enough that IDENTITY_DESTROYED's planted look-alikes are
 * not drowned out by unrelated traffic.
 */
export const MERCHANTS: readonly Merchant[] = [
  { canonical: 'AMAZON RETAIL', variants: ['AMZN', 'AMAZON RETAIL IN', 'Amazon Retail India Pvt Ltd'] },
  { canonical: 'FLIPKART INTERNET', variants: ['FKRT', 'FLIPKART INTERNET', 'Flipkart Internet Pvt Ltd'] },
  { canonical: 'BUNDL TECHNOLOGIES', variants: ['SWIGGY', 'SWIGGY BUNDL', 'Bundl Technologies Pvt Ltd'] },
  { canonical: 'ZOMATO LIMITED', variants: ['ZOMATO', 'ZOMATO MEDIA', 'Zomato Limited'] },
  { canonical: 'MYNTRA DESIGNS', variants: ['MYNTRA', 'MYNTRA JABONG', 'Myntra Designs Pvt Ltd'] },
  { canonical: 'INNOVATIVE RETAIL CONCEPTS', variants: ['BIGBASKET', 'SUPERMARKET GROCERY', 'Innovative Retail Concepts'] },
  { canonical: 'FSN E-COMMERCE', variants: ['NYKAA', 'NYKAA ECOMM', 'FSN E-Commerce Ventures'] },
  { canonical: 'BIGTREE ENTERTAINMENT', variants: ['BOOKMYSHOW', 'BMS TICKETS', 'Bigtree Entertainment Pvt Ltd'] },
  { canonical: 'MAKEMYTRIP INDIA', variants: ['MMT', 'MAKEMYTRIP IND', 'MakeMyTrip India Pvt Ltd'] },
  { canonical: 'URBAN COMPANY', variants: ['URBANCLAP', 'UC HOME SERVICES', 'Urban Company Ltd'] },
  { canonical: 'LENSKART SOLUTIONS', variants: ['LENSKART', 'LENSKART COM', 'Lenskart Solutions Pvt Ltd'] },
  { canonical: 'THREPSI SOLUTIONS', variants: ['PHARMEASY', 'API HOLDINGS', 'Threpsi Solutions Pvt Ltd'] },
  { canonical: 'CUREFIT HEALTHCARE', variants: ['CULT FIT', 'CUREFIT HEALTH', 'Curefit Healthcare Pvt Ltd'] },
  { canonical: 'DELIGHTFUL GOURMET', variants: ['LICIOUS', 'DELIGHTFUL GOURMET', 'Delightful Gourmet Pvt Ltd'] },
];

/**
 * UPI-dominant, as an Indian payments batch is. The mix matters because the date
 * window is per method (schema.md §5.2): a dataset that was 90% cards would leave
 * the UPI settlement window untested by the data.
 */
const METHOD_WEIGHTS: readonly { value: PaymentMethod; weight: number }[] = [
  { value: 'upi', weight: 45 },
  { value: 'card', weight: 30 },
  { value: 'netbanking', weight: 15 },
  { value: 'wallet', weight: 10 },
];

/**
 * Round retail price points. These are the source of NATURAL collisions — several
 * customers paying ₹499 to the same merchant on the same day is ordinary, and it
 * is what makes IDENTITY_DESTROYED plausible rather than contrived, and what
 * keeps the engine's ambiguity guard from being tested only against planted data.
 */
const RETAIL_PRICE_POINTS_RUPEES: readonly number[] = [
  99, 149, 199, 249, 299, 349, 399, 449, 499, 599, 699, 749, 799, 899, 999,
  1199, 1299, 1499, 1799, 1999, 2499, 2999, 3499, 3999, 4999, 5999, 7999, 9999,
  12999, 14999, 19999,
];

/**
 * THE AMOUNT DISTRIBUTION IS A MEASUREMENT DECISION, not flavour.
 *
 * The amount tolerance (schema.md §5.1) is `clamp(0.5% of amount, ₹1, ₹100)` —
 * three regimes, proportional only between ₹200 and ₹20,000 and clamped outside.
 * Draw amounts uniformly from a wide range and the dataset exercises one regime;
 * the ₹1 floor and the ₹100 cap, both of which §5.1 argues for at length, would
 * ship untested by the data and the measured accuracy would say nothing about
 * whether they were sized correctly.
 *
 * So the mixture is chosen to land events in all three, and to collide naturally:
 *   52%  round retail price points   — collisions, and mostly the proportional band
 *   26%  log-uniform ₹200-₹20,000    — arbitrary paise inside the proportional band
 *   14%  ₹20-₹199                    — the ₹1.00 floor regime (§5.1's ₹50 example)
 *    8%  ₹20,001-₹5,00,000           — the ₹100.00 cap regime
 */
const AMOUNT_BANDS = [
  { kind: 'retail', weight: 52 },
  { kind: 'proportional', weight: 26 },
  { kind: 'small', weight: 14 },
  { kind: 'large', weight: 8 },
] as const;

function logUniformPaise(rng: Rng, minPaise: number, maxPaise: number): number {
  const lo = Math.log(minPaise);
  const hi = Math.log(maxPaise);
  return Math.round(Math.exp(lo + rng.nextFloat() * (hi - lo)));
}

function drawAmountPaise(rng: Rng): number {
  const band = rng.weightedPick(AMOUNT_BANDS.map((b) => ({ value: b.kind, weight: b.weight })));
  switch (band) {
    case 'retail':
      return rng.pick(RETAIL_PRICE_POINTS_RUPEES) * 100;
    case 'small':
      return rng.nextInt(20_00, 199_99);
    // Both wide bands are log-uniform, so they are covered evenly in MAGNITUDE
    // rather than piling up near the top the way a linear draw does. It matters
    // more for the large band than it looks: drawn linearly, the mean big-ticket
    // payment lands near ₹2.6 lakh and the 95th percentile of the whole dataset
    // sits above ₹1.9 lakh, which is not a retail payments mix — and severity is
    // computed from money at risk (ADR-044), so the exception list would skew
    // `high` for a reason that came from the generator rather than the data.
    case 'large':
      return logUniformPaise(rng, 20_001_00, 500_000_00);
    case 'proportional':
      return logUniformPaise(rng, 200_00, 20_000_00);
  }
}

export interface EventPlanOptions {
  /** Number of economic events. ~300 gives a 200-500 record run (§1). */
  count: number;
  /**
   * Last day an event may occur, `YYYY-MM-DD`. REQUIRED and never defaulted from
   * the clock: `new Date()` is forbidden under `tools/` and a dataset whose dates
   * depend on when it was generated is not reproducible.
   */
  windowEndDate: string;
  /** Inclusive span ending at `windowEndDate`. */
  windowDays: number;
  specs?: Readonly<Record<Scenario, ScenarioSpec>>;
}

export interface EventPlan {
  events: readonly EconomicEvent[];
  /** What was ACTUALLY generated, for the manifest (§3). Never the idealized targets. */
  realizedDistribution: Readonly<Record<Scenario, number>>;
  window: { startDate: string; endDate: string; days: number };
}

export const DEFAULT_EVENT_PLAN: Pick<EventPlanOptions, 'count' | 'windowEndDate' | 'windowDays'> = {
  count: 300,
  windowEndDate: '2026-08-20',
  windowDays: 30,
};

/**
 * Plan every economic event. Deterministic in `rng`'s seed and nothing else.
 *
 * Each field draws from its OWN named sub-stream, which is what `derive` is for:
 * changing the amount model must not reshuffle merchants or dates, or every
 * regenerate-and-compare during development shows "everything changed" and
 * localising a scoring regression becomes impossible.
 *
 * DATES ARE CALENDAR DAYS, not business days. Indian settlement genuinely skips
 * weekends, and modelling that here would be more realistic — but the engine's
 * date window (schema.md §5.2) is expressed in calendar days, so a dataset with
 * weekend structure would penalise the engine for a pattern it was never built to
 * reason about, and the measured accuracy would report that gap as a matching
 * failure. Do not put structure in the data the engine does not model.
 */
export function planEvents(rng: Rng, options: EventPlanOptions): EventPlan {
  const { count, windowEndDate, windowDays, specs = SCENARIO_SPECS } = options;
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error(`planEvents: count must be a positive integer, got ${count}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(windowEndDate)) {
    throw new Error(`planEvents: windowEndDate must be YYYY-MM-DD, got "${windowEndDate}"`);
  }
  if (!Number.isSafeInteger(windowDays) || windowDays <= 0) {
    throw new Error(`planEvents: windowDays must be a positive integer, got ${windowDays}`);
  }

  const allocation = allocateScenarios(count, specs);
  const slots: Scenario[] = [];
  for (const [scenario, n] of allocation) for (let i = 0; i < n; i += 1) slots.push(scenario);

  const order = rng.derive('events.scenario-order');
  const amounts = rng.derive('events.amount');
  const dates = rng.derive('events.date');
  const merchants = rng.derive('events.merchant');
  const methods = rng.derive('events.method');

  const startDate = addDays(windowEndDate, -(windowDays - 1));
  const shuffled = order.shuffle(slots);

  const events = shuffled.map((scenario, i): EconomicEvent => ({
    eventId: `evt_${String(i).padStart(6, '0')}`,
    scenario,
    canonical: {
      amountPaise: drawAmountPaise(amounts),
      date: addDays(startDate, dates.nextInt(0, windowDays - 1)),
      merchant: merchants.pick(MERCHANTS).canonical,
      method: methods.weightedPick(METHOD_WEIGHTS),
      // The only scenario whose economic direction is not a credit. A refund IS a
      // debit — this is a canonical fact, not a defect applied to a projection.
      direction: scenario === 'REFUND_REVERSAL' ? 'debit' : 'credit',
    },
  }));

  const realized = Object.fromEntries(
    (Object.keys(specs) as Scenario[]).map((s) => [s, allocation.get(s) ?? 0]),
  ) as Record<Scenario, number>;

  return { events, realizedDistribution: realized, window: { startDate, endDate: windowEndDate, days: windowDays } };
}
