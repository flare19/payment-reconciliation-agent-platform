/**
 * The projection invariants — executable, and written BEFORE the projection that
 * must satisfy them.
 *
 * ===========================================================================
 * THESE PROTECT THE MEASUREMENT, NOT THE CODE.
 *
 * Every failure here is silent and inverted: the generator produces a plausible
 * dataset, the engine reconciles it correctly, and the scorer reports the engine
 * as wrong. `validation-strategy.md` §3 names the two that matter most and says
 * so out loud — "get these wrong and the engine looks broken for reasons that are
 * actually the generator's fault". Nothing downstream can detect them, because
 * every downstream component is behaving correctly.
 *
 * So they THROW. A generator that warns produces a dataset somebody measures
 * anyway, and the warning scrolls past.
 * ===========================================================================
 */

import { amountToleranceBand } from '../../apps/api/src/services/matching/tolerance.js';
import { ENGINE_DEFAULTS } from '../../apps/api/src/config/defaults.js';
import type { RunConfig } from '../../apps/api/src/types/engine.js';
import { SCENARIO_SPECS, type SourceSlot } from './scenarios.js';
import {
  GATEWAY_NOISE_STATUSES, LEDGER_NOISE_STATUSES, SOURCE_COLUMNS,
  type BankRow, type EventProjection, type GatewayRow, type LedgerRow,
  type ProjectedRow, type ProjectionResult,
} from './projection.js';

export interface InvariantViolation {
  /** The rule that failed, named so a reader can go read it. */
  invariant: string;
  eventId: string | null;
  detail: string;
}

const rows = <T extends ProjectedRow['sourceSystem']>(
  p: readonly ProjectedRow[], source: T,
): Extract<ProjectedRow, { sourceSystem: T }>[] =>
  p.filter((r): r is Extract<ProjectedRow, { sourceSystem: T }> => r.sourceSystem === source);

/** Bank transaction types that move money OUT. Everything else credits. */
const DEBIT_TYPES = new Set(['CHARGEBACK', 'FEE']);

const isWholePaise = (n: number): boolean => Number.isSafeInteger(n);

/**
 * Check every projection invariant and return ALL violations.
 *
 * All, not the first: a generator run that is wrong is usually wrong in several
 * ways at once, and fixing them one round-trip at a time is how a proof step
 * becomes something people skip.
 */
export function checkProjectionInvariants(
  result: ProjectionResult,
  config: RunConfig = { ...ENGINE_DEFAULTS, referenceDate: '2026-08-20', aliasCountAtStart: 0 },
): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const fail = (invariant: string, eventId: string | null, detail: string): void => {
    out.push({ invariant, eventId, detail });
  };

  for (const projection of result.events) {
    const { event } = projection;
    const id = event.eventId;
    const spec = SCENARIO_SPECS[event.scenario];
    const gateway = rows(projection.rows, 'gateway');
    const bank = rows(projection.rows, 'bank');
    const ledger = rows(projection.rows, 'ledger');

    // ─── structure ───────────────────────────────────────────────────────────
    for (const row of projection.rows) {
      if (row.eventId !== id) {
        fail('event-rows-carry-their-event-id', id,
          `a ${row.sourceSystem} row claims event ${String(row.eventId)}`);
      }
      for (const column of row.blankedColumns) {
        if (!SOURCE_COLUMNS[row.sourceSystem as SourceSlot].includes(column)) {
          fail('blanked-columns-are-real-columns', id,
            `${row.sourceSystem} blanks "${column}", which is not one of its columns`);
        }
      }
    }

    const present = [...new Set(projection.rows.map((r) => r.sourceSystem))].sort();
    // UNSPLITTABLE_NET_BATCH is the one scenario where a declared source is
    // OPTIONAL: one bank credit nets N payments, so at most one member event can
    // carry that row and the rest legitimately have no bank leg. (Which member
    // carries it is G6's to decide; that it is at most one is fixed here.)
    const declared = [...spec.sources]
      .filter((src) => !(event.scenario === 'UNSPLITTABLE_NET_BATCH' && src === 'bank' && bank.length === 0))
      .sort();
    if (present.join(',') !== declared.join(',')) {
      // Catches a projection stage that forgot to DROP a leg — MISSING_IN_LEDGER
      // with a ledger row is not a missing-ledger event, and the key would be
      // asserting an exception the engine has no reason to raise.
      fail('sources-match-the-scenario', id,
        `${event.scenario} declares [${declared.join(', ')}] but projected [${present.join(', ')}]`);
    }

    // ─── ADR-037 · ledger net EQUALS gateway gross, exactly ──────────────────
    // Gateway amount is what the customer was charged, which is the ledger NET
    // (after discount, including sale GST) and never the ledger gross. Emit
    // gross-equals-gateway instead and every discounted sale becomes a false
    // AMOUNT_MISMATCH, filling the exception list with arithmetic artifacts that
    // read as engine failures.
    const grossPaise = gateway[0]?.amountPaise;
    if (gateway.length > 1 && gateway.some((g) => g.amountPaise !== grossPaise)) {
      fail('gateway-rows-of-one-event-agree-on-amount', id,
        `gateway rows disagree: ${gateway.map((g) => g.amountPaise).join(' vs ')}`);
    }
    if (grossPaise !== undefined && ledger.length > 0) {
      for (const l of ledger) {
        const mismatched = l.netAmountPaise !== grossPaise;
        if (event.scenario === 'AMOUNT_TRUE_MISMATCH') {
          // The mirror of ADR-037, and it needs the ENGINE'S tolerance, because
          // §2.4 defines this defect as "beyond any tolerance" and the only
          // honest reading of "any" is the band the engine actually applies. A
          // "true mismatch" that lands inside tolerance is not a mismatch: the
          // engine would match it correctly and the key would call that an error.
          const band = amountToleranceBand(grossPaise, config);
          const delta = Math.abs(l.netAmountPaise - grossPaise);
          if (delta <= band) {
            fail('AMOUNT_TRUE_MISMATCH-exceeds-tolerance', id,
              `delta ${delta} paise is inside the ${band} paise tolerance band, so this is a match`);
          }
        } else if (mismatched) {
          fail('ADR-037/ledger-net-equals-gateway-gross', id,
            `ledger net ${l.netAmountPaise} != gateway amount ${grossPaise} ` +
            `(difference ${l.netAmountPaise - grossPaise} paise)`);
        }
      }
    }

    // ─── arithmetic inside each row ──────────────────────────────────────────
    for (const g of gateway) checkGatewayArithmetic(g, id, fail);
    for (const l of ledger) checkLedgerArithmetic(l, id, fail);
    for (const b of bank) checkBankRow(b, id, fail);

    // ─── ADR-034 · a duplicate carries the SAME STRONG ANCHOR ────────────────
    // Duplicates are detected by anchor evidence, never by amount+date+
    // counterparty similarity, because IDENTITY_DESTROYED deliberately plants 3+
    // same-amount, same-day, same-merchant ANCHORLESS rows. A similarity-based
    // duplicate rule would classify the dataset's hardest designed case as
    // duplicates, so the two scenarios must stay distinguishable BY CONSTRUCTION
    // and this is the constraint that keeps them so.
    if (event.scenario === 'DUPLICATE_ROW') {
      const duplicated: SourceSlot[] = [];
      if (gateway.length > 1) duplicated.push('gateway');
      if (ledger.length > 1) duplicated.push('ledger');
      if (bank.length > 1) duplicated.push('bank');

      if (duplicated.length !== 1) {
        fail('ADR-034/duplicate-appears-in-exactly-one-source', id,
          duplicated.length === 0
            ? 'DUPLICATE_ROW produced no duplicated row'
            : `duplicated in ${duplicated.join(' and ')}; §2.4 is one source`);
      }
      if (bank.length > 1) {
        // A statement does not re-emit a UTR. Allowing it would give the engine a
        // duplicate with no cross-source anchor to detect it by.
        fail('ADR-034/bank-does-not-duplicate', id, 'bank emitted the same event twice');
      }
      if (gateway.length > 1 && new Set(gateway.map((g) => g.paymentId)).size !== 1) {
        fail('ADR-034/duplicate-shares-strong-anchor', id,
          `gateway duplicates carry different payment_ids: ${gateway.map((g) => g.paymentId).join(', ')}`);
      }
      if (ledger.length > 1) {
        const refs = ledger.map((l) => l.gatewayRef);
        if (refs.some((r) => r === null) || new Set(refs).size !== 1) {
          fail('ADR-034/duplicate-shares-strong-anchor', id,
            `ledger duplicates need one shared non-null gateway_ref, got ${refs.map(String).join(', ')}`);
        }
      }
    } else if (gateway.length > 1 || ledger.length > 1) {
      fail('only-DUPLICATE_ROW-duplicates', id,
        `${event.scenario} emitted more than one gateway or ledger row`);
    }
    // Several bank rows are legitimate for exactly one scenario: a payment settled
    // across 2-4 credits. Anywhere else they are a duplicate the engine has no
    // anchor evidence to detect.
    if (bank.length > 1 && event.scenario !== 'SPLIT_SETTLEMENT') {
      fail('only-SPLIT_SETTLEMENT-has-several-bank-legs', id,
        `${event.scenario} emitted ${bank.length} bank rows`);
    }

    // ─── ADR-035 · direction ─────────────────────────────────────────────────
    // A credit never matches a debit. This is the only scenario that exercises
    // that gate, so if the data does not carry it the guard ships unverified.
    const wantsDebit = event.canonical.direction === 'debit';
    for (const g of gateway) {
      const expected = wantsDebit ? 'refunded' : 'captured';
      if (g.status !== expected) {
        fail('ADR-035/gateway-status-matches-direction', id,
          `direction ${event.canonical.direction} wants status "${expected}", got "${g.status}"`);
      }
    }
    if (gateway.length > 0) {
      for (const b of bank) {
        const isDebit = b.debitAmountPaise !== null;
        if (isDebit !== wantsDebit) {
          fail('ADR-035/bank-leg-matches-direction', id,
            `event is a ${event.canonical.direction} but the bank row is a ${isDebit ? 'debit' : 'credit'}`);
        }
      }
    }

    // ─── settlement arithmetic ───────────────────────────────────────────────
    const credits = bank.filter((b) => b.creditAmountPaise !== null);
    const netPaise = gateway[0]?.netAmountPaise;
    if (netPaise !== undefined && !wantsDebit) {
      if (event.scenario === 'SPLIT_SETTLEMENT') {
        const sum = credits.reduce((s, b) => s + (b.creditAmountPaise ?? 0), 0);
        if (credits.length < 2 || credits.length > 4) {
          fail('SPLIT_SETTLEMENT/two-to-four-legs', id, `${credits.length} bank credits`);
        }
        if (sum !== netPaise) {
          fail('SPLIT_SETTLEMENT/legs-sum-to-net', id, `legs sum to ${sum}, gateway net is ${netPaise}`);
        }
      } else if (event.scenario !== 'UNSPLITTABLE_NET_BATCH' && credits.length === 1) {
        // A batch credit nets many events, so it is deliberately not checked here.
        if (credits[0]!.creditAmountPaise !== netPaise) {
          fail('bank-credit-equals-gateway-net', id,
            `credited ${credits[0]!.creditAmountPaise}, gateway net is ${netPaise}`);
        }
      }
    }
  }

  // ─── noise: rows outside the event model ───────────────────────────────────
  // They exist to verify the engine FILTERS rather than fails. A noise row that
  // reached the matching population would be counted as an exception, inflating
  // the exception count — the opposite failure from hiding exceptions, and
  // equally dishonest.
  for (const row of result.noise.rows) {
    if (row.eventId !== null) {
      fail('noise-rows-have-no-event', null, `${row.sourceSystem} noise row claims event ${row.eventId}`);
    }
    if (!row.defects.includes('NOISE_ROW')) {
      fail('noise-rows-are-keyed-NOISE_ROW', null, `${row.sourceSystem} noise row is not keyed`);
    }
    if (row.sourceSystem === 'gateway'
      && !(GATEWAY_NOISE_STATUSES as readonly string[]).includes(row.status)) {
      fail('noise-rows-carry-an-excluded-status', null, `gateway noise row status "${row.status}"`);
    }
    if (row.sourceSystem === 'ledger'
      && !(LEDGER_NOISE_STATUSES as readonly string[]).includes(row.status)) {
      fail('noise-rows-carry-an-excluded-status', null, `ledger noise row status "${row.status}"`);
    }
    if (row.sourceSystem === 'bank' && row.transactionType !== 'FEE') {
      // ADR-036: FEE is the only bank type excluded at ingestion. CHARGEBACK and
      // MISC_CREDIT stay in the reconcilable population by design.
      fail('bank-noise-is-FEE-only', null, `bank noise row is ${row.transactionType}`);
    }
  }
  return out;
}

function checkGatewayArithmetic(
  g: GatewayRow, id: string, fail: (i: string, e: string | null, d: string) => void,
): void {
  for (const [name, value] of [['amount', g.amountPaise], ['fee', g.feePaise],
    ['tax', g.taxPaise], ['net_amount', g.netAmountPaise]] as const) {
    if (!isWholePaise(value)) fail('amounts-are-whole-paise', id, `gateway ${name} = ${value}`);
  }
  if (g.amountPaise <= 0) fail('amounts-are-positive', id, `gateway amount ${g.amountPaise}`);
  if (g.feePaise < 0 || g.taxPaise < 0) {
    fail('fees-are-not-negative', id, `fee ${g.feePaise}, tax ${g.taxPaise}`);
  }
  if (g.netAmountPaise !== g.amountPaise - g.feePaise - g.taxPaise) {
    fail('gateway-net-is-amount-minus-fee-and-tax', id,
      `${g.netAmountPaise} != ${g.amountPaise} - ${g.feePaise} - ${g.taxPaise}`);
  }
  // §2.1: net_amount is blank WHENEVER fee is blank. A row that states a net it
  // did not show the working for would hand the fee-inference path (§5.3) a free
  // answer it is supposed to have to derive.
  if (g.blankedColumns.includes('fee') && !g.blankedColumns.includes('net_amount')) {
    fail('blank-fee-implies-blank-net', id, 'fee is blanked but net_amount is emitted');
  }
}

function checkLedgerArithmetic(
  l: LedgerRow, id: string, fail: (i: string, e: string | null, d: string) => void,
): void {
  for (const [name, value] of [['gross_amount', l.grossAmountPaise], ['discount', l.discountPaise],
    ['tax_amount', l.taxAmountPaise], ['net_amount', l.netAmountPaise]] as const) {
    if (!isWholePaise(value)) fail('amounts-are-whole-paise', id, `ledger ${name} = ${value}`);
  }
  if (l.netAmountPaise !== l.grossAmountPaise - l.discountPaise + l.taxAmountPaise) {
    fail('ledger-net-is-gross-minus-discount-plus-tax', id,
      `${l.netAmountPaise} != ${l.grossAmountPaise} - ${l.discountPaise} + ${l.taxAmountPaise}`);
  }
  if (l.discountPaise < 0) fail('discount-is-not-negative', id, `discount ${l.discountPaise}`);
}

function checkBankRow(
  b: BankRow, id: string, fail: (i: string, e: string | null, d: string) => void,
): void {
  const hasCredit = b.creditAmountPaise !== null;
  const hasDebit = b.debitAmountPaise !== null;
  if (hasCredit === hasDebit) {
    fail('bank-row-is-a-credit-or-a-debit', id,
      hasCredit ? 'both credit and debit are set' : 'neither credit nor debit is set');
  }
  const amount = b.creditAmountPaise ?? b.debitAmountPaise;
  if (amount !== null && (!isWholePaise(amount) || amount <= 0)) {
    fail('amounts-are-positive', id, `bank amount ${amount}`);
  }
  if (hasDebit !== DEBIT_TYPES.has(b.transactionType)) {
    fail('bank-direction-matches-transaction-type', id,
      `${b.transactionType} emitted as a ${hasDebit ? 'debit' : 'credit'}`);
  }
}

/**
 * Throw unless every invariant holds. This is what the generator calls.
 *
 * The message lists every violation, because a run that is wrong is usually wrong
 * in several ways and discovering them one at a time is how a proof step becomes
 * something people skip.
 */
export function assertProjectionInvariants(result: ProjectionResult, config?: RunConfig): void {
  const violations = config === undefined
    ? checkProjectionInvariants(result)
    : checkProjectionInvariants(result, config);
  if (violations.length === 0) return;
  const shown = violations.slice(0, 25)
    .map((v) => `  [${v.invariant}] ${v.eventId ?? 'noise'}: ${v.detail}`).join('\n');
  const more = violations.length > 25 ? `\n  … and ${violations.length - 25} more` : '';
  throw new Error(
    `The generated projection violates ${violations.length} invariant(s). ` +
    `These are silent and inverted: the dataset would look plausible and the ENGINE ` +
    `would be scored as wrong for the generator's mistake.\n${shown}${more}`,
  );
}
