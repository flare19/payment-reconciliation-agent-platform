/**
 * Tolerance bands, date windows, and which amount is compared to which.
 *
 * These three decisions determine what the engine considers "the same amount on
 * the same day", so every accuracy number in the project is downstream of this
 * file. Each value has an ADR; none may be changed without appending one.
 */

import type {
  BusinessDate, DateWindow, Direction, PaymentMethod, Paise, SourceSystem,
} from '../../types/domain.js';
import type { ComparisonBasis, NormalizedTransaction, RunConfig } from '../../types/engine.js';
import { dayDelta } from '../ingestion/dates.js';

/**
 * Banded amount tolerance (ADR-008): `clamp(0.5% × amount, ₹1.00, ₹100.00)`.
 *
 * 0.5% sits deliberately BELOW the real gateway fee band (2.36–2.95%), because
 * fee differences are handled by an explicit net-amount rule rather than absorbed
 * by a loose tolerance. Setting this to 3% to "absorb fees" is the tempting
 * mistake: it would silently match records whose amounts genuinely disagree, and
 * AMOUNT_MISMATCH — the category a finance controller most needs to trust — would
 * stop firing on real discrepancies.
 *
 * Computed in integer space. `amountPaise * pct` with pct = 0.005 is a float
 * multiplication whose error can flip a value sitting exactly on a .5 boundary,
 * and a tolerance that differs by one paisa between two runs is a determinism
 * bug. Scaling the percentage to parts-per-million keeps the multiply exact
 * (≤ 5×10^14 for realistic amounts, well inside the safe-integer range).
 */
export function amountToleranceBand(amountPaise: Paise, config: RunConfig): Paise {
  const ppm = Math.round(config.amountTolerancePct * 1_000_000);
  const raw = Math.round((Math.abs(amountPaise) * ppm) / 1_000_000);
  if (raw < config.amountToleranceFloorPaise) return config.amountToleranceFloorPaise;
  if (raw > config.amountToleranceCapPaise) return config.amountToleranceCapPaise;
  return raw;
}

/**
 * The expected net band when the gateway did not state a fee (schema.md §5.3.2).
 * `expected_net ∈ [gross × (1 − feeMax), gross × (1 − feeMin)]`.
 */
export function expectedNetBand(
  grossPaise: Paise, config: RunConfig,
): { lowPaise: Paise; highPaise: Paise } {
  const minPpm = Math.round(config.feeBandMinPct * 1_000_000);
  const maxPpm = Math.round(config.feeBandMaxPct * 1_000_000);
  return {
    lowPaise: Math.round((grossPaise * (1_000_000 - maxPpm)) / 1_000_000),
    highPaise: Math.round((grossPaise * (1_000_000 - minPpm)) / 1_000_000),
  };
}

/** An unordered source pair, normalised so the caller's argument order is irrelevant. */
export type PairKind = 'gateway_bank' | 'gateway_ledger' | 'bank_ledger';

export function pairKind(a: SourceSystem, b: SourceSystem): PairKind | null {
  const key = [a, b].sort().join('_');
  if (key === 'bank_gateway') return 'gateway_bank';
  if (key === 'gateway_ledger') return 'gateway_ledger';
  if (key === 'bank_ledger') return 'bank_ledger';
  return null; // same source — not a cross-source pair
}

/**
 * Date window for a pair (ADR-009), always expressed RELATIVE TO THE GATEWAY DATE
 * where a gateway record is involved.
 *
 * Asymmetric on purpose: settlement flows forward in time, so a symmetric window
 * is wrong in both directions at once. The `-1` on every window is not slack — it
 * is required by real IST/UTC midnight drift, and without it every near-midnight
 * payment becomes a false exception.
 */
export function dateWindowFor(
  kind: PairKind, method: PaymentMethod | null, config: RunConfig,
): DateWindow {
  switch (kind) {
    case 'gateway_bank':
      return method === 'upi' || method === 'wallet'
        ? config.dateWindowUpiDays
        : config.dateWindowCardDays;
    case 'gateway_ledger':
      return config.dateWindowLedgerDays;
    case 'bank_ledger':
      return config.dateWindowBankLedgerDays;
  }
}

/**
 * Which quantity is compared for this pair (ADR-037). Stated once, here, so no
 * tier re-derives it and no two tiers can disagree.
 */
export function comparisonBasisFor(
  a: NormalizedTransaction, b: NormalizedTransaction,
): { basis: ComparisonBasis; kind: PairKind } | null {
  const kind = pairKind(a.sourceSystem, b.sourceSystem);
  if (kind === null) return null;

  if (kind === 'gateway_bank') {
    const gateway = a.sourceSystem === 'gateway' ? a : b;
    return {
      kind,
      basis: gateway.netAmountPaise === null
        ? 'gateway_net_inferred_vs_bank_credit'
        : 'gateway_net_vs_bank_credit',
    };
  }
  if (kind === 'gateway_ledger') return { kind, basis: 'gateway_gross_vs_ledger_net' };

  // bank ↔ ledger: no arithmetic relates a fee-net bank credit to a sale amount
  // including sale GST without the gateway row in between. Scoring them against
  // each other would be the same category error §5.3.3 forbids for gateway net
  // vs ledger net, so the amount component is marked UNAVAILABLE rather than 0.
  return { kind, basis: 'anchor_only' };
}

export interface AmountEvaluation {
  /** Signed: candidate minus expected. Zero when the value lands inside an inferred band. */
  deltaPaise: Paise;
  tolerancePaise: Paise;
  within: boolean;
  basis: ComparisonBasis;
  /** True for bank↔ledger: not a failure to agree, an absence of a comparable quantity. */
  unavailable: boolean;
  /** True when the engine inferred a value the source never stated (ADR-037 / §5.3.2). */
  inferred: boolean;
}

/**
 * Compare the two records' amounts on the correct basis.
 *
 * For the inferred-fee case the "expected" value is a BAND, not a point. A credit
 * landing inside the band has delta 0 — it is exactly as expected — and one
 * outside is measured from the nearer edge, so the penalty grows from the edge of
 * plausibility rather than from an arbitrary midpoint.
 */
export function evaluateAmount(
  a: NormalizedTransaction, b: NormalizedTransaction, config: RunConfig,
): AmountEvaluation | null {
  const resolved = comparisonBasisFor(a, b);
  if (resolved === null) return null;
  const { basis, kind } = resolved;

  if (basis === 'anchor_only') {
    return {
      deltaPaise: 0, tolerancePaise: 0, within: false,
      basis, unavailable: true, inferred: false,
    };
  }

  if (kind === 'gateway_ledger') {
    const gateway = a.sourceSystem === 'gateway' ? a : b;
    const ledger = a.sourceSystem === 'ledger' ? a : b;
    // Gateway gross vs ledger NET: both are what the customer was charged.
    // Comparing ledger GROSS would make every discounted or taxed sale an
    // AMOUNT_MISMATCH and flood the exception list with arithmetic artifacts.
    const expected = gateway.amountPaise;
    const actual = ledger.netAmountPaise ?? ledger.amountPaise;
    const tolerance = amountToleranceBand(expected, config);
    const delta = actual - expected;
    return {
      deltaPaise: delta, tolerancePaise: tolerance,
      within: Math.abs(delta) <= tolerance,
      basis, unavailable: false, inferred: false,
    };
  }

  // gateway ↔ bank
  const gateway = a.sourceSystem === 'gateway' ? a : b;
  const bank = a.sourceSystem === 'bank' ? a : b;
  const actual = bank.amountPaise;

  if (gateway.netAmountPaise !== null) {
    const expected = gateway.netAmountPaise;
    const tolerance = amountToleranceBand(expected, config);
    const delta = actual - expected;
    return {
      deltaPaise: delta, tolerancePaise: tolerance,
      within: Math.abs(delta) <= tolerance,
      basis, unavailable: false, inferred: false,
    };
  }

  // The ~15% blank-fee rows: accept a credit inside the expected band plus the
  // ordinary tolerance.
  const band = expectedNetBand(gateway.amountPaise, config);
  const tolerance = amountToleranceBand(gateway.amountPaise, config);
  let delta: number;
  if (actual < band.lowPaise) delta = actual - band.lowPaise;
  else if (actual > band.highPaise) delta = actual - band.highPaise;
  else delta = 0;

  return {
    deltaPaise: delta, tolerancePaise: tolerance,
    within: Math.abs(delta) <= tolerance,
    basis, unavailable: false, inferred: true,
  };
}

export interface DateEvaluation {
  /** Signed days, always oriented as (later source − gateway) where gateway exists. */
  deltaDays: number;
  window: DateWindow;
  within: boolean;
}

export function evaluateDate(
  a: NormalizedTransaction, b: NormalizedTransaction, config: RunConfig,
): DateEvaluation | null {
  const kind = pairKind(a.sourceSystem, b.sourceSystem);
  if (kind === null) return null;

  // Orientation matters: the windows are defined relative to the gateway date, so
  // measuring them backwards would turn a normal T+2 settlement into a -2 outlier.
  let anchor: NormalizedTransaction;
  let other: NormalizedTransaction;
  if (kind === 'bank_ledger') {
    anchor = a.sourceSystem === 'bank' ? a : b;
    other = a.sourceSystem === 'ledger' ? a : b;
  } else {
    anchor = a.sourceSystem === 'gateway' ? a : b;
    other = a.sourceSystem === 'gateway' ? b : a;
  }

  const method = anchor.sourceSystem === 'gateway' ? anchor.method : null;
  const window = dateWindowFor(kind, method, config);
  const delta = dayDelta(anchor.txnDate, other.txnDate);
  return { deltaDays: delta, window, within: delta >= window[0] && delta <= window[1] };
}

/** Direction is a HARD GATE at every tier, never a scored component (ADR-035). */
export function directionAgrees(a: Direction, b: Direction): boolean {
  return a === b;
}

export function isOverdue(
  txnDate: BusinessDate, referenceDate: BusinessDate, window: DateWindow,
): boolean {
  // Uses runs.reference_date, never the wall clock (ADR-039).
  return dayDelta(txnDate, referenceDate) > window[1];
}
