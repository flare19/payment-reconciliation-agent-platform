/**
 * Planting the designed-unresolvable structures (validation-strategy.md §4).
 *
 * §4 says the generator PLANTS these — "the generator plants 3+ same-amount,
 * same-day, same-merchant candidates". Planting is a distinct step from event
 * planning because it is structural: it rewrites the canonical facts of several
 * events so that they become mutually indistinguishable, which is not something
 * an independent per-event draw can produce.
 *
 * It lives next to the proofs deliberately. A plant without a proof is a label,
 * and §4's whole argument is that these are proven properties of the dataset
 * rather than claims about it — the difference between "we think this is
 * impossible" and an answer to a sceptical panelist asking "how do you know?".
 */

import type { Rng } from './prng.js';
import type { EconomicEvent } from './events.js';
import { MERCHANTS } from './events.js';
import { addDays } from '../../apps/api/src/services/ingestion/dates.js';

/** §4: "assert ≥3 candidate rows are byte-identical on every field the matcher can see". */
export const MIN_AMBIGUOUS_CLUSTER = 3;

export interface IdentityCluster {
  /** Events whose canonical facts were made identical. */
  eventIds: readonly string[];
}

export interface PlantResult {
  events: readonly EconomicEvent[];
  identityClusters: readonly IdentityCluster[];
}

/**
 * Rewrite every `IDENTITY_DESTROYED` event into a cluster of at least three
 * events sharing identical canonical facts.
 *
 * The shared amount is drawn from the retail price points rather than at random,
 * because a cluster on ₹1,999 is something that plausibly happens and a cluster
 * on ₹7,431.62 is visibly manufactured. The dataset has to survive a reader
 * looking at it, not only a scorer.
 *
 * Clusters are as equal in size as the count allows, with remainder spread one
 * per cluster from the front, so the sizes are a pure function of the count.
 */
export function plantIdentityClusters(rng: Rng, events: readonly EconomicEvent[]): PlantResult {
  const targets = events.filter((e) => e.scenario === 'IDENTITY_DESTROYED');
  if (targets.length === 0) return { events, identityClusters: [] };

  if (targets.length < MIN_AMBIGUOUS_CLUSTER) {
    // Honest failure rather than a cluster of two. Two indistinguishable rows are
    // an ordinary ambiguous pair; §4's claim is specifically that no information
    // distinguishes THREE OR MORE, and a dataset too small to carry that should
    // say so rather than quietly weaken the claim.
    throw new Error(
      `plantIdentityClusters: ${targets.length} IDENTITY_DESTROYED event(s) cannot form a cluster ` +
      `of ${MIN_AMBIGUOUS_CLUSTER}. Raise the event count or the scenario weight.`);
  }

  const clusterCount = Math.floor(targets.length / MIN_AMBIGUOUS_CLUSTER);
  const sizes = new Array<number>(clusterCount).fill(MIN_AMBIGUOUS_CLUSTER);
  for (let i = 0; i < targets.length - clusterCount * MIN_AMBIGUOUS_CLUSTER; i += 1) {
    sizes[i % clusterCount]! += 1;
  }

  const facts = rng.derive('plant.identity');
  const rewritten = new Map<string, EconomicEvent>();
  const clusters: IdentityCluster[] = [];

  let cursor = 0;
  for (const size of sizes) {
    const members = targets.slice(cursor, cursor + size);
    cursor += size;

    const shared = {
      amountPaise: facts.pick(AMBIGUITY_PRICE_POINTS_RUPEES) * 100,
      // Anchored to the first member's date so the cluster stays inside the
      // window the events were planned within.
      date: members[0]!.canonical.date,
      merchant: facts.pick(MERCHANTS).canonical,
      method: facts.pick(['card', 'upi', 'netbanking', 'wallet'] as const),
    };
    for (const member of members) {
      rewritten.set(member.eventId, {
        ...member,
        canonical: { ...member.canonical, ...shared, direction: 'credit' },
      });
    }
    clusters.push({ eventIds: members.map((m) => m.eventId) });
  }

  return {
    events: events.map((e) => rewritten.get(e.eventId) ?? e),
    identityClusters: clusters,
  };
}

/**
 * Round price points a cluster can sit on without looking manufactured. A subset
 * of the retail points: the very small ones would make a three-way ambiguity on
 * ₹99 read as noise rather than as a genuine reconciliation problem.
 */
const AMBIGUITY_PRICE_POINTS_RUPEES: readonly number[] = [
  499, 599, 799, 999, 1199, 1499, 1999, 2499, 2999, 4999,
];

/**
 * The date a batch settlement credit lands, given the last payment it nets.
 * Exported so the proof and the projection agree on one definition.
 */
export function settlementDateFor(lastPaymentDate: string, lagDays: number): string {
  return addDays(lastPaymentDate, lagDays);
}
