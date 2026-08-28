/**
 * §4's unresolvability PROOFS — the difference between a label and a property.
 *
 * ===========================================================================
 * "GENUINELY UNRESOLVABLE" IS A CLAIM UNTIL IT IS CHECKED, and it is the claim
 * a sceptical panelist will probe first, because it is what sets the ~93%
 * ceiling every other number is reported against. §4 is explicit that the
 * generator does not merely label these:
 *
 *   IDENTITY_DESTROYED      assert ≥3 candidates indistinguishable after
 *                           normalization; regenerate if not
 *   UNSPLITTABLE_NET_BATCH  run a REAL subset-sum against the credit ±
 *                           tolerance; regenerate if a subset exists
 *   ORPHAN_NO_COUNTERPART   assert no event references the row
 *
 * Unresolvability that only holds because MY search is weak is not
 * unresolvability. So every proof runs the ENGINE'S own code — its normalizer,
 * its tolerance band, its subset search. A second implementation here would
 * prove a property of the generator rather than of the dataset, which is exactly
 * the failure ADR-049 forbids for the agent, arriving one layer down.
 * ===========================================================================
 */

import { normalizeCounterparty } from '../../apps/api/src/services/ingestion/normalize.js';
import { amountToleranceBand } from '../../apps/api/src/services/matching/tolerance.js';
import { contributionOf, searchSubsets } from '../../apps/api/src/services/matching/batch-decomposition.js';
import { dayDelta } from '../../apps/api/src/services/ingestion/dates.js';
import { ENGINE_DEFAULTS } from '../../apps/api/src/config/defaults.js';
import type { NormalizedTransaction, RunConfig } from '../../apps/api/src/types/engine.js';
import type { GatewayRow, BankRow, ProjectionResult } from './projection.js';
import type { IdentityCluster } from './planting.js';
import { MIN_AMBIGUOUS_CLUSTER } from './planting.js';

export interface ProofFailure {
  proof: string;
  eventId: string | null;
  detail: string;
}

export const DEFAULT_PROOF_CONFIG: RunConfig =
  { ...ENGINE_DEFAULTS, referenceDate: '2026-08-20', aliasCountAtStart: 0 };

/**
 * A gateway row as the MATCHER will see it.
 *
 * NOT a parser, and deliberately not shaped like one. It exists so the engine's
 * own `contributionOf` and `searchSubsets` can be run over generated rows before
 * the real parser exists, and it makes exactly ONE judgment: `netAmountPaise` is
 * null precisely when the row blanks `fee`/`net_amount`, which is what forces the
 * engine down its fee-inference path. Everything else is either a value carried
 * straight through or an inert carrier the batch code never reads.
 *
 * Counterparty normalization is the engine's function, never a local lowercase —
 * the whole point of the identity proof is that rows are indistinguishable to the
 * ENGINE, and "indistinguishable after my own normalization" would be a different
 * and much weaker claim.
 */
export function matcherView(row: GatewayRow, sourceRowNumber: number): NormalizedTransaction {
  const netIsBlank = row.blankedColumns.includes('net_amount');
  return {
    id: `${row.eventId ?? 'noise'}:${sourceRowNumber}`,
    runId: 'generator-proof',
    sourceSystem: 'gateway',
    sourceFile: 'gateway_export.csv',
    sourceRowNumber,
    externalId: row.paymentId,
    referenceIds: {
      ...(row.blankedColumns.includes('payment_id') ? {} : { payment_id: row.paymentId }),
      ...(row.orderId !== null && !row.blankedColumns.includes('order_id') ? { order_id: row.orderId } : {}),
      ...(row.rrn !== null && !row.blankedColumns.includes('rrn') ? { rrn: row.rrn } : {}),
      ...(row.settlementId !== null && !row.blankedColumns.includes('settlement_id')
        ? { settlement_id: row.settlementId } : {}),
    },
    anchorStrength: 'none',
    amountPaise: row.amountPaise,
    feePaise: row.blankedColumns.includes('fee') ? null : row.feePaise,
    taxPaise: row.blankedColumns.includes('tax') ? null : row.taxPaise,
    netAmountPaise: netIsBlank ? null : row.netAmountPaise,
    currency: row.currency,
    direction: row.status === 'refunded' ? 'debit' : 'credit',
    txnDate: row.createdAt.slice(0, 10),
    txnTimestamp: null,
    postingDate: null,
    counterpartyRaw: row.merchantName,
    counterpartyNorm: normalizeCounterparty(row.merchantName),
    counterpartyKey: null,
    method: row.method,
    statusRaw: row.status,
    statusNorm: 'reconcilable',
    txnType: null,
    descriptionRaw: null,
    duplicateOfTransactionId: null,
    duplicateKind: null,
    ingestWarnings: [],
    rawPayload: {},
  };
}

/** Every anchor the engine could use to tell two rows apart. Empty means it cannot. */
function anchorsOf(row: GatewayRow): string[] {
  const view = matcherView(row, 0);
  return [
    ...Object.entries(view.referenceIds)
      .filter(([, v]) => typeof v === 'string' && v !== '')
      .map(([k, v]) => `${k}=${String(v)}`),
  ];
}

// ─── §4 · IDENTITY_DESTROYED ─────────────────────────────────────────────────

/**
 * Prove that a cluster's members are indistinguishable to the matcher.
 *
 * "Byte-identical on every field the matcher can see" (§4) means: no anchor of
 * any kind survives on any member, and the fields that remain — normalized
 * counterparty, business date, amount, direction — agree exactly. If ANY of
 * those differ, the engine has a basis to choose and the event is merely hard.
 */
export function proveIdentityDestroyed(
  result: ProjectionResult, clusters: readonly IdentityCluster[],
): ProofFailure[] {
  const out: ProofFailure[] = [];
  const byEvent = new Map(result.events.map((p) => [p.event.eventId, p]));

  for (const cluster of clusters) {
    const lead = cluster.eventIds[0] ?? null;
    if (cluster.eventIds.length < MIN_AMBIGUOUS_CLUSTER) {
      out.push({ proof: 'IDENTITY_DESTROYED/cluster-size', eventId: lead,
        detail: `cluster of ${cluster.eventIds.length}, need ${MIN_AMBIGUOUS_CLUSTER}` });
      continue;
    }

    const signatures: string[] = [];
    for (const eventId of cluster.eventIds) {
      const projection = byEvent.get(eventId);
      if (projection === undefined) {
        out.push({ proof: 'IDENTITY_DESTROYED/member-projected', eventId,
          detail: 'cluster member has no projection' });
        continue;
      }
      const gateways = projection.rows.filter((r): r is GatewayRow => r.sourceSystem === 'gateway');
      if (gateways.length === 0) {
        out.push({ proof: 'IDENTITY_DESTROYED/member-projected', eventId,
          detail: 'cluster member projected no gateway row' });
        continue;
      }
      for (const g of gateways) {
        const anchors = anchorsOf(g);
        if (anchors.length > 0) {
          // A surviving anchor is a way to tell this row from its cluster-mates,
          // and one survivor collapses the whole claim.
          out.push({ proof: 'IDENTITY_DESTROYED/no-anchor-survives', eventId,
            detail: `anchor still readable: ${anchors.join(', ')}` });
        }
        const view = matcherView(g, 0);
        signatures.push([view.amountPaise, view.txnDate, view.counterpartyNorm, view.direction].join('|'));
      }
    }

    const distinct = new Set(signatures);
    if (distinct.size > 1) {
      out.push({ proof: 'IDENTITY_DESTROYED/members-are-indistinguishable', eventId: lead,
        detail: `cluster has ${distinct.size} distinct signatures: ${[...distinct].join('  /  ')}` });
    }
  }
  return out;
}

// ─── §4 · UNSPLITTABLE_NET_BATCH ─────────────────────────────────────────────

/**
 * Prove that no subset of the available payments sums into the credit's band.
 *
 * Runs the ENGINE'S `searchSubsets` over contributions built by the ENGINE'S
 * `contributionOf`, so a "no decomposition exists" claim means no decomposition
 * the engine's own S10 could find.
 *
 * `stats.complete` is checked as well as `solutions.length`, and that check is
 * the whole difference between a proof and a hopeful result: a search that hit
 * its node budget or its subset cap found nothing because it STOPPED, not because
 * nothing is there. Reporting that as unresolvable would put a claim in the
 * answer key that the generator never established.
 */
export function proveUnsplittableBatch(
  credit: BankRow,
  poolRows: readonly GatewayRow[],
  eventId: string | null,
  config: RunConfig = DEFAULT_PROOF_CONFIG,
): ProofFailure[] {
  const target = credit.creditAmountPaise;
  if (target === null) {
    return [{ proof: 'UNSPLITTABLE_BATCH/credit-is-a-credit', eventId,
      detail: 'the batch row carries no credit amount' }];
  }
  const contributions = poolRows.map((row, i) => contributionOf(matcherView(row, i + 1), config));
  const tolerance = amountToleranceBand(target, config);
  const { solutions, stats } = searchSubsets(contributions, target, tolerance, config, false);

  const out: ProofFailure[] = [];
  if (solutions.length > 0) {
    const found = solutions[0]!.map((c) => c.transaction.externalId).join(' + ');
    out.push({ proof: 'UNSPLITTABLE_BATCH/no-subset-sums-into-the-band', eventId,
      detail: `a decomposition EXISTS (${found}), so this batch is resolvable and must be regenerated` });
  }
  if (!stats.exhaustive) {
    // `exhaustive` is the engine's OWN honesty distinction (ADR-060/063): the
    // declared subset-size cap is part of the question, while the pool cap and the
    // node budget are a failure to answer it. Reusing that distinction rather than
    // inventing one means "unresolvable" in the key and "searchExhausted" in the
    // engine mean the same thing.
    out.push({ proof: 'UNSPLITTABLE_BATCH/search-was-exhaustive', eventId,
      detail: `the search stopped early (${JSON.stringify(stats.boundHit)}), so "no subset" is unproven` });
  }
  return out;
}

// ─── §4 · ORPHAN_NO_COUNTERPART ──────────────────────────────────────────────

/**
 * Prove the orphan has nothing it could plausibly be matched to.
 *
 * §4 phrases this as "assert no event references the row", which is true by
 * construction and therefore proves nothing on its own. The property that
 * actually has to hold is stronger: no gateway payment anywhere in the dataset is
 * a CREDIBLE counterpart — because if one is, the engine may pair them, the pair
 * would be a false positive, and the answer key would be calling a correct
 * engine wrong.
 *
 * Credible means what the engine means: inside the settlement date window, same
 * normalized counterparty, amount inside the engine's own tolerance band.
 */
export function proveOrphanHasNoCounterpart(
  orphan: BankRow,
  allGateways: readonly GatewayRow[],
  eventId: string | null,
  config: RunConfig = DEFAULT_PROOF_CONFIG,
): ProofFailure[] {
  const amount = orphan.creditAmountPaise ?? orphan.debitAmountPaise;
  if (amount === null) {
    return [{ proof: 'ORPHAN/row-carries-an-amount', eventId, detail: 'neither credit nor debit set' }];
  }
  const orphanParty = normalizeCounterparty(orphan.description);
  const [lo, hi] = config.dateWindowCardDays;
  const tolerance = amountToleranceBand(amount, config);

  for (const g of allGateways) {
    const view = matcherView(g, 0);
    const offset = dayDelta(view.txnDate, orphan.valueDate);
    if (offset < lo || offset > hi) continue;
    if (orphanParty !== null && view.counterpartyNorm !== null && view.counterpartyNorm !== orphanParty) continue;
    const candidateAmount = view.netAmountPaise ?? view.amountPaise;
    if (Math.abs(candidateAmount - amount) <= tolerance) {
      return [{ proof: 'ORPHAN/has-no-credible-counterpart', eventId,
        detail: `gateway ${view.externalId} (${candidateAmount} paise, ${view.txnDate}) is inside ` +
          `tolerance ${tolerance} and the date window — the orphan is matchable and must be regenerated` }];
    }
  }
  return [];
}

/**
 * Run a proof, regenerating on failure, and THROW if the attempts run out.
 *
 * Bounded and deterministic: each attempt draws from its own named sub-stream, so
 * the sequence of attempts is a function of the seed and re-running reproduces
 * the same path. Unbounded retry is the shape that turns a proof step into a
 * hang, and silently accepting the last attempt is the shape that turns it into
 * decoration — §4's claim only means something if failure is loud.
 */
export function proveWithRegeneration<T>(
  attempts: number,
  regenerate: (attempt: number) => T,
  prove: (candidate: T) => ProofFailure[],
  label: string,
): T {
  if (attempts < 1) throw new Error(`proveWithRegeneration: attempts must be >= 1, got ${attempts}`);
  let last: ProofFailure[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = regenerate(attempt);
    last = prove(candidate);
    if (last.length === 0) return candidate;
  }
  throw new Error(
    `${label}: ${attempts} attempts all failed their proof, so the dataset cannot honestly claim ` +
    `this class is unresolvable. Last failures:\n` +
    last.slice(0, 10).map((f) => `  [${f.proof}] ${f.eventId ?? '-'}: ${f.detail}`).join('\n'));
}
