/**
 * Phase 2 — projecting one economic event into source rows (validation-strategy
 * §1 Phase 2, schema.md §2, §2.4).
 *
 * ===========================================================================
 * DETERMINISTIC AND RETRY-SAFE. `projectEvent` derives its own sub-stream keyed
 * by `(event.eventId, attempt)` from whatever `Rng` it is given, so calling it
 * twice with `attempt: 1` after `attempt: 0` failed a §4 proof produces a
 * DIFFERENT, still-reproducible projection for that ONE event without disturbing
 * any other event's draws — the same edit-stability property `Rng.derive` exists
 * for (ADR-067), applied to regeneration rather than to development iteration.
 *
 * WHAT THIS FILE DOES NOT DO: run the invariants (invariants.ts, already built)
 * or the §4 proofs (proofs.ts, already built) or assemble the batch groups that
 * need whole-dataset context (index.ts, which has that context). This file only
 * constructs rows for ONE event at a time — everything cross-event lives in the
 * orchestrator.
 * ===========================================================================
 */

import type { Direction, PaymentMethod } from '../../apps/api/src/types/domain.js';
import type { RunConfig } from '../../apps/api/src/types/engine.js';
import { addDays } from '../../apps/api/src/services/ingestion/dates.js';
import { amountToleranceBand } from '../../apps/api/src/services/matching/tolerance.js';
import type { Rng } from './prng.js';
import type { EconomicEvent, Merchant } from './events.js';
import { MERCHANTS } from './events.js';
import type { DefectCode, BankRow, GatewayRow, LedgerRow, ProjectedRow } from './projection.js';
import {
  formatGatewayTimestamp, plusSeconds, genPaymentId, genOrderId, genRrn, genUtr, genSettlementId,
  genInvoiceNo, genEntryId, genAccountCode, typoTranspose, truncateMidToken,
} from './format.js';

let invoiceSequence = 0;
let entrySequence = 0;

/**
 * Sequential IDs (`INV/2026/00123`, `JE-004417`) reset per generator process.
 * Exported so `index.ts` can reset between independent runs (tests generating
 * more than one dataset in the same process) without cross-run collisions.
 */
export function resetSequentialIds(): void {
  invoiceSequence = 0;
  entrySequence = 0;
}

const nextInvoiceNo = (): string => genInvoiceNo((invoiceSequence += 1));
const nextEntryId = (): string => genEntryId((entrySequence += 1));

/** Settlement lag in days, gateway -> bank, by method (schema.md §5.2). */
function normalLagDays(rng: Rng, method: PaymentMethod): number {
  return method === 'card' || method === 'netbanking' ? rng.pick([0, 1]) : rng.pick([0, 1]);
}
function edgeLagDays(rng: Rng, method: PaymentMethod): number {
  return method === 'card' || method === 'netbanking' ? rng.pick([2, 3]) : rng.pick([1, 2]);
}

/** A gateway wall-clock time. `nearMidnight` draws inside 90 minutes of IST midnight (TZ_MIDNIGHT_DRIFT). */
function drawTimeOfDay(rng: Rng, nearMidnight: boolean): { hour: number; minute: number; second: number } {
  const second = rng.nextInt(0, 59);
  if (nearMidnight) {
    // Within 90 minutes of 00:00 IST: 00:00-01:29.
    const totalMinutes = rng.nextInt(0, 89);
    return { hour: Math.floor(totalMinutes / 60), minute: totalMinutes % 60, second };
  }
  return { hour: rng.nextInt(6, 22), minute: rng.nextInt(0, 59), second };
}

/**
 * The gateway fee/GST split for a captured amount (schema.md §5.3: 2.0-2.5% fee,
 * 18% GST on the fee). Drawn inside the engine's own inferred-fee band
 * (`feeBandMinPct`/`feeBandMaxPct`) so a row whose fee is later BLANKED still
 * falls inside the band the engine would infer for it — a fee outside that band
 * would make the fee-inference path (§5.3.2) fail for a reason that has nothing
 * to do with what it is meant to test.
 */
function computeFeeSplit(rng: Rng, amountPaise: number, config: RunConfig): { feePaise: number; taxPaise: number; netPaise: number } {
  const pct = config.feeBandMinPct + rng.nextFloat() * (config.feeBandMaxPct - config.feeBandMinPct);
  // feePaise + taxPaise together equal round(amount * pct); split by the stated
  // 18% GST-on-fee relationship: fee = total / 1.18, tax = total - fee.
  const totalDeduction = Math.round(amountPaise * pct);
  const feePaise = Math.round(totalDeduction / 1.18);
  const taxPaise = totalDeduction - feePaise;
  return { feePaise, taxPaise, netPaise: amountPaise - feePaise - taxPaise };
}

/**
 * A bank description blob embedding whichever anchors should survive.
 *
 * `NEFT-SETL-<merchant>-<rrn>-<settlementId>-BATCH##`, with either identifier
 * omitted when it should not be extractable. Rail prefix and BATCH suffix are
 * exactly `normalizeBankDescription`'s vocabulary (ingestion/normalize.ts §3.3
 * steps 5), and the RRN/settlement_id sit as isolated, dash-delimited tokens so
 * a straightforward parser regex can lift them out cleanly — the structured
 * `anchor_strength: strong` path (schema.md §3.2) depends on that isolation.
 */
function buildBankDescription(
  rng: Rng, merchant: string, rrn: string | null, settlementId: string | null,
): string {
  const rail = rng.pick(['NEFT', 'IMPS', 'UPI'] as const);
  const parts = [rail, 'SETL', merchant, ...(rrn !== null ? [rrn] : []),
    ...(settlementId !== null ? [settlementId] : []), `BATCH${rng.nextInt(1, 99)}`];
  return parts.join('-');
}

// ─── the "mostly clean" 3-way family ──────────────────────────────────────────
// CLEAN_3WAY, TIMING_LAG_NORMAL, FEE_NET_SETTLEMENT, MERCHANT_NAME_VARIANT and
// REFUND_REVERSAL share one skeleton and differ only in which flags are set —
// they are variations on "a payment that genuinely happened and settled",
// distinguished by WHAT is varied, not by structure.

interface ThreeWayOptions {
  /** Whether the bank description carries an extractable rrn/settlement_id. False forces the pair to fuzzy. */
  bankAnchorExtractable: boolean;
  lagDays: number;
  /** Force fee/tax/net_amount blank on the gateway row, regardless of the baseline roll. */
  forceFeeBlank: boolean;
  /** Use a different name variant per source (MERCHANT_NAME_VARIANT). */
  varyMerchantName: boolean;
  /** REFUND_REVERSAL: gateway status 'refunded', bank leg a debit. */
  refund: boolean;
}

function buildThreeWay(
  rng: Rng, event: EconomicEvent, config: RunConfig, opts: ThreeWayOptions,
): { gateway: GatewayRow; bank: BankRow; ledger: LedgerRow } {
  const { amountPaise, date, merchant, method, direction } = event.canonical;
  const merchantEntry = MERCHANTS.find((m) => m.canonical === merchant) as Merchant;

  const nameFor = (source: 'gateway' | 'bank' | 'ledger'): string => {
    if (!opts.varyMerchantName) return merchant;
    // Each source draws its OWN variant, so all three can legitimately differ —
    // "same merchant, different string per source" (§3's own phrasing).
    return rng.pick([merchant, ...merchantEntry.variants]);
  };

  const paymentId = genPaymentId(rng);
  const orderId = genOrderId(rng);
  const rrn = genRrn(rng);
  const settlementId = genSettlementId(rng);

  const nearMidnight = rng.bool(0.04);
  const time = drawTimeOfDay(rng, nearMidnight);
  const captured = plusSeconds(time, 2);
  const gatewayDefects: DefectCode[] = [];
  if (nearMidnight) gatewayDefects.push('TZ_MIDNIGHT_DRIFT');

  // TZ_MIDNIGHT_DRIFT: a UTC-booking downstream system files the settlement one
  // day EARLIER than the gateway's own IST business date (schema.md §2.4). The
  // -1 on every date window (ADR-009) exists for exactly this case.
  const utcCrossOffset = nearMidnight ? -1 : 0;
  const bankDate = addDays(date, utcCrossOffset + opts.lagDays);
  const ledgerDate = addDays(date, rng.bool(0.7) ? 0 : 1);

  const gatewayBlankOrderId = rng.bool(0.08);
  const gatewayBlankRrn = method === 'upi' ? rng.bool(0.20) : rng.bool(0.05);
  const gatewayBlankFee = opts.forceFeeBlank || rng.bool(0.15);
  const gatewayBlankCapturedAt = rng.bool(0.10);

  const { feePaise, taxPaise, netPaise } = computeFeeSplit(rng, amountPaise, config);

  const gatewayBlanked: string[] = [];
  if (gatewayBlankOrderId) gatewayBlanked.push('order_id');
  if (gatewayBlankRrn) gatewayBlanked.push('rrn');
  if (gatewayBlankFee) gatewayBlanked.push('fee', 'tax', 'net_amount');
  if (gatewayBlankCapturedAt) gatewayBlanked.push('captured_at');

  const gateway: GatewayRow = {
    sourceSystem: 'gateway', eventId: event.eventId, defects: gatewayDefects, blankedColumns: gatewayBlanked,
    paymentId, orderId, method, status: opts.refund ? 'refunded' : 'captured',
    amountPaise, currency: 'INR', feePaise, taxPaise, netAmountPaise: netPaise,
    createdAt: formatGatewayTimestamp(date, time.hour, time.minute, time.second),
    // `plusSeconds`, not `second + 2`: a naive add produces :60/:61, which
    // parseSourceDate rejects — and a rejected row leaves the population.
    capturedAt: gatewayBlankCapturedAt ? null
      : formatGatewayTimestamp(date, captured.hour, captured.minute, captured.second),
    merchantName: nameFor('gateway'), customerEmail: rng.bool(0.7) ? `${randomHandle(rng)}@example.com` : null,
    rrn, settlementId,
    notes: null,
  };

  const bankDefects: DefectCode[] = [];
  if (!opts.bankAnchorExtractable) bankDefects.push('REF_MISSING');
  const description = buildBankDescription(
    rng, nameFor('bank'), opts.bankAnchorExtractable ? rrn : null, opts.bankAnchorExtractable ? settlementId : null);

  const bank: BankRow = {
    sourceSystem: 'bank', eventId: event.eventId, defects: bankDefects, blankedColumns: [],
    utr: genUtr(rng), valueDate: bankDate, postingDate: rng.bool(0.85) ? bankDate : addDays(bankDate, 1),
    description,
    creditAmountPaise: opts.refund ? null : netPaise,
    debitAmountPaise: opts.refund ? netPaise : null,
    closingBalancePaise: rng.nextInt(10_00_00_00, 99_00_00_00),
    bankRefNo: rng.bool(0.5) ? rrn : randomHandle(rng).toUpperCase(),
    transactionType: opts.refund ? 'CHARGEBACK' : 'SETTLEMENT',
  };

  const ledgerBlankGatewayRef = rng.bool(0.12);
  const ledgerTypoGatewayRef = !ledgerBlankGatewayRef && rng.bool(0.04);
  const ledgerDefects: DefectCode[] = [];
  const ledgerBlanked: string[] = [];
  let gatewayRef: string | null = paymentId;
  if (ledgerBlankGatewayRef) { gatewayRef = null; ledgerBlanked.push('gateway_ref'); ledgerDefects.push('REF_MISSING'); }
  else if (ledgerTypoGatewayRef) { gatewayRef = typoTranspose(rng, paymentId); ledgerDefects.push('REF_TYPO'); }

  const ledger: LedgerRow = {
    sourceSystem: 'ledger', eventId: event.eventId, defects: ledgerDefects, blankedColumns: ledgerBlanked,
    entryId: nextEntryId(), invoiceNo: nextInvoiceNo(), gatewayRef,
    customerName: nameFor('ledger'),
    grossAmountPaise: amountPaise, discountPaise: 0, taxAmountPaise: 0, netAmountPaise: amountPaise,
    entryDate: ledgerDate, accountCode: genAccountCode(rng),
    postedBy: rng.pick(['sysuser', 'batch_import', 'accounts_team']),
    memo: null, status: 'posted',
  };

  return { gateway, bank, ledger };
}

function randomHandle(rng: Rng): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 8; i += 1) out += letters[rng.nextInt(0, letters.length - 1)];
  return out;
}

// ─── per-scenario constructors ────────────────────────────────────────────────

function projectCleanLike(rng: Rng, event: EconomicEvent, config: RunConfig): ProjectedRow[] {
  const { gateway, bank, ledger } = buildThreeWay(rng, event, config, {
    bankAnchorExtractable: true, lagDays: normalLagDays(rng, event.canonical.method),
    forceFeeBlank: false, varyMerchantName: false, refund: false,
  });
  return [gateway, bank, ledger];
}

function projectTimingLagNormal(rng: Rng, event: EconomicEvent, config: RunConfig): ProjectedRow[] {
  const { gateway, bank, ledger } = buildThreeWay(rng, event, config, {
    // No extractable anchor on the bank leg: correlation happens via amount +
    // date + counterparty at Tier 2, which is the whole reason this scenario is
    // "at fuzzy" rather than "at exact" (§3).
    bankAnchorExtractable: false, lagDays: edgeLagDays(rng, event.canonical.method),
    forceFeeBlank: false, varyMerchantName: false, refund: false,
  });
  bank.defects = [...bank.defects, 'SETTLEMENT_LAG'];
  return [gateway, bank, ledger];
}

function projectFeeNetSettlement(rng: Rng, event: EconomicEvent, config: RunConfig): ProjectedRow[] {
  const { gateway, bank, ledger } = buildThreeWay(rng, event, config, {
    bankAnchorExtractable: true, lagDays: normalLagDays(rng, event.canonical.method),
    forceFeeBlank: true, varyMerchantName: false, refund: false,
  });
  gateway.defects = [...gateway.defects, 'AMOUNT_FEE_DELTA'];
  return [gateway, bank, ledger];
}

function projectMerchantNameVariant(rng: Rng, event: EconomicEvent, config: RunConfig): ProjectedRow[] {
  const { gateway, bank, ledger } = buildThreeWay(rng, event, config, {
    bankAnchorExtractable: true, lagDays: normalLagDays(rng, event.canonical.method),
    forceFeeBlank: false, varyMerchantName: true, refund: false,
  });
  gateway.defects = [...gateway.defects, 'MERCHANT_NAME_VARIANT'];
  ledger.defects = [...ledger.defects, 'MERCHANT_NAME_VARIANT'];
  return [gateway, bank, ledger];
}

function projectRefundReversal(rng: Rng, event: EconomicEvent, config: RunConfig): ProjectedRow[] {
  const { gateway, bank, ledger } = buildThreeWay(rng, event, config, {
    bankAnchorExtractable: true, lagDays: normalLagDays(rng, event.canonical.method),
    forceFeeBlank: false, varyMerchantName: false, refund: true,
  });
  bank.defects = [...bank.defects, 'REFUND_REVERSAL'];
  return [gateway, bank, ledger];
}

function projectAmountTrueMismatch(rng: Rng, event: EconomicEvent, config: RunConfig): ProjectedRow[] {
  const { gateway, bank, ledger } = buildThreeWay(rng, event, config, {
    bankAnchorExtractable: true, lagDays: normalLagDays(rng, event.canonical.method),
    forceFeeBlank: false, varyMerchantName: false, refund: false,
  });
  // Genuinely beyond tolerance: at least 4x the tolerance band, signed either way,
  // and adjusted so the LEDGER's own arithmetic (net = gross - discount + tax)
  // still holds — the mismatch lives in gross, not in a broken internal sum.
  const band = amountToleranceBand(gateway.amountPaise, config);
  const delta = (band * 4 + rng.nextInt(1, band)) * (rng.bool(0.5) ? 1 : -1);
  ledger.grossAmountPaise = gateway.amountPaise + delta;
  ledger.netAmountPaise = ledger.grossAmountPaise - ledger.discountPaise + ledger.taxAmountPaise;
  ledger.defects = [...ledger.defects, 'AMOUNT_TRUE_MISMATCH'];
  return [gateway, bank, ledger];
}

function projectDuplicateRow(rng: Rng, event: EconomicEvent, config: RunConfig): ProjectedRow[] {
  const { gateway, bank, ledger } = buildThreeWay(rng, event, config, {
    bankAnchorExtractable: true, lagDays: normalLagDays(rng, event.canonical.method),
    forceFeeBlank: false, varyMerchantName: false, refund: false,
  });
  gateway.defects = [...gateway.defects, 'DUPLICATE_ROW'];
  // ADR-034 requires the copy to carry the SAME strong anchor, so the baseline
  // ~12% blank / ~4% typo roll on gateway_ref (buildThreeWay) must be undone
  // here — a duplicate whose own anchor is missing is a different, unrelated
  // defect (REF_MISSING_OR_TYPO's job), not a retry artifact.
  ledger.gatewayRef = gateway.paymentId;
  ledger.blankedColumns = ledger.blankedColumns.filter((c) => c !== 'gateway_ref');
  ledger.defects = [...ledger.defects.filter((d) => d !== 'REF_MISSING' && d !== 'REF_TYPO'), 'DUPLICATE_ROW'];

  // Duplicate the gateway leg or the ledger leg — never bank (a statement does
  // not re-emit a UTR; ADR-034). The copy is the SAME strong anchor with a
  // slightly later timestamp, which is what a retry artifact actually looks like.
  if (rng.bool(0.5)) {
    const retry: GatewayRow = { ...gateway,
      createdAt: formatGatewayTimestamp(event.canonical.date,
        Number(gateway.createdAt.slice(11, 13)), Number(gateway.createdAt.slice(14, 16)),
        Math.min(59, Number(gateway.createdAt.slice(17, 19)) + 3)) };
    return [gateway, retry, bank, ledger];
  }
  const retry: LedgerRow = { ...ledger, entryId: nextEntryId(), invoiceNo: nextInvoiceNo() };
  return [gateway, bank, ledger, retry];
}

function projectMissingInLedger(rng: Rng, event: EconomicEvent, config: RunConfig): ProjectedRow[] {
  const { gateway, bank } = buildThreeWay(rng, event, config, {
    bankAnchorExtractable: true, lagDays: normalLagDays(rng, event.canonical.method),
    forceFeeBlank: false, varyMerchantName: false, refund: false,
  });
  bank.defects = [...bank.defects, 'MISSING_ROW'];
  return [gateway, bank];
}

function projectMissingInBank(rng: Rng, event: EconomicEvent, config: RunConfig): ProjectedRow[] {
  const { gateway, ledger } = buildThreeWay(rng, event, config, {
    bankAnchorExtractable: true, lagDays: normalLagDays(rng, event.canonical.method),
    forceFeeBlank: false, varyMerchantName: false, refund: false,
  });
  // Never settled through anything traceable — a major MISSING_IN_BANK source
  // (schema.md §2.1). Blanked rather than merely "unused" so the reason is legible.
  gateway.settlementId = null;
  gateway.blankedColumns = [...gateway.blankedColumns, 'settlement_id'];
  gateway.defects = [...gateway.defects, 'MISSING_ROW'];
  ledger.defects = [...ledger.defects, 'MISSING_ROW'];
  return [gateway, ledger];
}

/**
 * One pair's connecting anchor is damaged (blank, typo'd, or a truncated bank
 * description), the OTHERS stay intact — "matches at fuzzy while an anchor
 * survives" (§3). NEVER all three, which would be IDENTITY_DESTROYED under
 * another name; `buildAnswerKey` throws on that, and this constructor never
 * produces it because exactly one pair is chosen to degrade.
 */
function projectRefMissingOrTypo(rng: Rng, event: EconomicEvent, config: RunConfig): ProjectedRow[] {
  const { gateway, bank, ledger } = buildThreeWay(rng, event, config, {
    bankAnchorExtractable: true, lagDays: normalLagDays(rng, event.canonical.method),
    forceFeeBlank: false, varyMerchantName: false, refund: false,
  });

  const which = rng.pick(['ledger-blank', 'ledger-typo', 'bank-truncated'] as const);
  switch (which) {
    case 'ledger-blank':
      ledger.gatewayRef = null;
      ledger.blankedColumns = [...ledger.blankedColumns, 'gateway_ref'];
      ledger.defects = [...ledger.defects, 'REF_MISSING'];
      break;
    case 'ledger-typo':
      ledger.gatewayRef = typoTranspose(rng, gateway.paymentId);
      ledger.defects = [...ledger.defects, 'REF_TYPO'];
      break;
    case 'bank-truncated':
      bank.description = truncateMidToken(rng, bank.description);
      bank.defects = [...bank.defects, 'DESC_TRUNCATED'];
      break;
  }
  return [gateway, bank, ledger];
}

/**
 * A payment settled across 2-4 bank credits (§2.4 SPLIT_SETTLEMENT, ADR-038
 * SPLIT_SETTLEMENT_V1). The legs sum EXACTLY to gateway net — checked by
 * G3's invariant — and all reference the same settlement identity, because a
 * real split settlement is one payment's money arriving in pieces, not several
 * unrelated credits that happen to add up.
 */
function projectSplitSettlement(rng: Rng, event: EconomicEvent, config: RunConfig): ProjectedRow[] {
  const { gateway, bank: firstLeg, ledger } = buildThreeWay(rng, event, config, {
    bankAnchorExtractable: true, lagDays: normalLagDays(rng, event.canonical.method),
    forceFeeBlank: false, varyMerchantName: false, refund: false,
  });
  const legCount = rng.nextInt(2, 4);
  const netPaise = gateway.netAmountPaise;

  // Split into `legCount` positive parts summing exactly to netPaise: draw
  // legCount-1 cut points on [1, netPaise-1] and take consecutive differences.
  const cuts = new Set<number>();
  while (cuts.size < legCount - 1) cuts.add(rng.nextInt(1, netPaise - 1));
  const sorted = [0, ...[...cuts].sort((a, b) => a - b), netPaise];
  const amounts = sorted.slice(1).map((v, i) => v - sorted[i]!);

  const legs: BankRow[] = amounts.map((amt, i) => ({
    ...firstLeg,
    utr: i === 0 ? firstLeg.utr : genUtr(rng),
    valueDate: addDays(firstLeg.valueDate, i === 0 ? 0 : rng.nextInt(0, 1)),
    creditAmountPaise: amt,
    defects: i === 0 ? [...firstLeg.defects, 'SPLIT_SETTLEMENT'] : ['SPLIT_SETTLEMENT'],
  }));

  gateway.defects = [...gateway.defects, 'SPLIT_SETTLEMENT'];
  return [gateway, ...legs, ledger];
}

/**
 * Every gateway anchor destroyed, matching §4's `IDENTITY_DESTROYED` definition
 * verbatim: "REF_MISSING on all projections, DESC_TRUNCATED cutting the RRN".
 * Canonical facts (amount/date/merchant/method) are ALREADY shared across the
 * cluster by `plantIdentityClusters` before this runs — this function's only job
 * is to make sure nothing here re-introduces a way to tell members apart.
 */
function projectIdentityDestroyed(rng: Rng, event: EconomicEvent, config: RunConfig): ProjectedRow[] {
  const time = drawTimeOfDay(rng, false);
  const { date, amountPaise, method } = event.canonical;
  const { feePaise, taxPaise, netPaise } = computeFeeSplit(rng, amountPaise, config);

  const gateway: GatewayRow = {
    sourceSystem: 'gateway', eventId: event.eventId, defects: ['REF_MISSING'],
    blankedColumns: ['payment_id', 'order_id', 'rrn', 'settlement_id'],
    paymentId: genPaymentId(rng), orderId: null, method, status: 'captured',
    amountPaise, currency: 'INR', feePaise, taxPaise, netAmountPaise: netPaise,
    createdAt: formatGatewayTimestamp(date, time.hour, time.minute, time.second),
    capturedAt: null, merchantName: event.canonical.merchant, customerEmail: null,
    rrn: null, settlementId: null, notes: null,
  };

  const bankDate = addDays(date, normalLagDays(rng, method));
  const bank: BankRow = {
    sourceSystem: 'bank', eventId: event.eventId, defects: ['DESC_TRUNCATED'], blankedColumns: [],
    utr: genUtr(rng), valueDate: bankDate, postingDate: bankDate,
    // Truncated past where any rail prefix or reference could survive — a bare
    // amount-adjacent fragment, which is what "cutting the RRN" (§4) looks like
    // taken to its edge.
    description: rng.pick(['NEFT-SE', 'IMPS-SET', 'UPI-S']),
    creditAmountPaise: netPaise, debitAmountPaise: null,
    closingBalancePaise: rng.nextInt(10_00_00_00, 99_00_00_00), bankRefNo: null,
    transactionType: 'SETTLEMENT',
  };

  const ledger: LedgerRow = {
    sourceSystem: 'ledger', eventId: event.eventId, defects: ['REF_MISSING'], blankedColumns: ['gateway_ref'],
    entryId: nextEntryId(), invoiceNo: nextInvoiceNo(), gatewayRef: null,
    customerName: event.canonical.merchant, grossAmountPaise: amountPaise, discountPaise: 0,
    taxAmountPaise: 0, netAmountPaise: amountPaise, entryDate: addDays(date, 0),
    accountCode: genAccountCode(rng), postedBy: 'sysuser', memo: null, status: 'posted',
  };

  return [gateway, bank, ledger];
}

/**
 * A bank row with no economic event behind it (§4 ORPHAN_NO_COUNTERPART). Filed
 * under this event's id per `HAS_NO_ECONOMIC_COUNTERPART` (scenarios.ts) — the
 * key needs a per-row expectation, and this event exists only to give it a home.
 */
function projectOrphanNoCounterpart(
  rng: Rng, event: EconomicEvent, _config: RunConfig,
): ProjectedRow[] {
  const type = rng.pick(['CHARGEBACK', 'MISC_CREDIT'] as const);
  const isCredit = type === 'MISC_CREDIT';
  const bank: BankRow = {
    sourceSystem: 'bank', eventId: event.eventId, defects: ['ORPHAN_ROW'], blankedColumns: [],
    utr: genUtr(rng), valueDate: event.canonical.date, postingDate: event.canonical.date,
    description: type === 'CHARGEBACK'
      ? `CHGBK-${rng.pick(['DISPUTE', 'REVERSAL'])}-${genRrn(rng)}`
      : `MISC-CREDIT-${randomHandle(rng).toUpperCase()}`,
    creditAmountPaise: isCredit ? event.canonical.amountPaise : null,
    debitAmountPaise: isCredit ? null : event.canonical.amountPaise,
    closingBalancePaise: rng.nextInt(10_00_00_00, 99_00_00_00), bankRefNo: null,
    transactionType: type,
  };
  return [bank];
}

/**
 * `UNSPLITTABLE_NET_BATCH` (§4): a gateway+ledger pair that matches cleanly on
 * its own (its own payment, fully resolvable), plus a SEPARATE "mystery"
 * settlement credit under the same merchant that no subset of the dataset's
 * gateway population can explain — proved, not asserted, by the orchestrator
 * calling `proveUnsplittableBatch` against this row.
 *
 * `creditAmountPaise` is drawn wide and log-uniform specifically so it is
 * unlikely to coincide with any real subset sum; the orchestrator regenerates
 * via `creditAttempt` on the rare case it does.
 *
 * `creditAttempt` deliberately affects ONLY the credit's own draws, via its own
 * derived sub-stream — the gateway/ledger pair is fixed regardless of attempt.
 * If retrying the credit also reshuffled this event's own gateway row, that row
 * sits in the SAME candidate pool every OTHER `UNSPLITTABLE_NET_BATCH`/
 * `ORPHAN_NO_COUNTERPART` event's proof was checked against, and a mid-run
 * change to it would invalidate proofs the orchestrator already accepted.
 * Keeping the pair stable removes that ordering hazard entirely rather than
 * requiring the orchestrator to re-verify everything after every retry.
 */
function projectUnsplittableNetBatch(
  rng: Rng, event: EconomicEvent, config: RunConfig, creditAttempt: number,
): { rows: ProjectedRow[]; credit: BankRow } {
  const pairRng = rng.derive('pair');
  const { gateway, ledger } = buildThreeWay(pairRng, event, config, {
    bankAnchorExtractable: true, lagDays: normalLagDays(pairRng, event.canonical.method),
    forceFeeBlank: false, varyMerchantName: false, refund: false,
  });
  // This event's own settlement never happened through anything traceable — the
  // whole point is that its money is not the mystery credit's money.
  gateway.settlementId = null;
  gateway.blankedColumns = [...gateway.blankedColumns, 'settlement_id'];

  const creditRng = rng.derive(`credit.${creditAttempt}`);
  const creditDate = addDays(event.canonical.date, creditRng.nextInt(3, 9));
  const lo = Math.log(50_000_00), hi = Math.log(5_00_000_00);
  const creditAmountPaise = Math.round(Math.exp(lo + creditRng.nextFloat() * (hi - lo)));

  const credit: BankRow = {
    sourceSystem: 'bank', eventId: event.eventId, defects: ['NET_SETTLEMENT_BATCH'], blankedColumns: [],
    utr: genUtr(creditRng), valueDate: creditDate, postingDate: creditDate,
    description: buildBankDescription(creditRng, event.canonical.merchant, null, null),
    creditAmountPaise, debitAmountPaise: null,
    closingBalancePaise: creditRng.nextInt(10_00_00_00, 99_00_00_00), bankRefNo: null,
    transactionType: 'SETTLEMENT',
  };

  return { rows: [gateway, ledger, credit], credit };
}

// ─── noise ─────────────────────────────────────────────────────────────────────

/**
 * Rows outside the event model — §3's ~25 gateway `failed`/`authorized` and ~12
 * ledger `draft`/`void`. They exist to prove the engine FILTERS rather than
 * fails on them; counting them as exceptions would inflate the exception count
 * dishonestly.
 */
export function projectNoise(
  rng: Rng, windowStart: string, windowDays: number, gatewayCount: number, ledgerCount: number,
): ProjectedRow[] {
  const out: ProjectedRow[] = [];
  const dates = rng.derive('noise.date');
  const ids = rng.derive('noise.ids');
  const amounts = rng.derive('noise.amount');

  for (let i = 0; i < gatewayCount; i += 1) {
    const status = ids.pick(['authorized', 'failed'] as const);
    const date = addDays(windowStart, dates.nextInt(0, windowDays - 1));
    const time = drawTimeOfDay(ids, false);
    out.push({
      sourceSystem: 'gateway', eventId: null, defects: ['NOISE_ROW'], blankedColumns: [],
      paymentId: genPaymentId(ids), orderId: ids.bool(0.5) ? genOrderId(ids) : null,
      method: ids.pick(['upi', 'card', 'netbanking', 'wallet'] as const), status,
      amountPaise: amounts.nextInt(50_00, 50_000_00), currency: 'INR',
      feePaise: 0, taxPaise: 0, netAmountPaise: 0,
      createdAt: formatGatewayTimestamp(date, time.hour, time.minute, time.second),
      capturedAt: null, merchantName: ids.pick(MERCHANTS).canonical, customerEmail: null,
      rrn: null, settlementId: null, notes: status === 'failed' ? 'Payment declined by issuer' : null,
    });
  }

  for (let i = 0; i < ledgerCount; i += 1) {
    const status = ids.pick(['draft', 'void'] as const);
    const date = addDays(windowStart, dates.nextInt(0, windowDays - 1));
    const gross = amounts.nextInt(50_00, 50_000_00);
    out.push({
      sourceSystem: 'ledger', eventId: null, defects: ['NOISE_ROW'], blankedColumns: [],
      entryId: nextEntryId(), invoiceNo: nextInvoiceNo(), gatewayRef: null,
      customerName: ids.pick(MERCHANTS).canonical, grossAmountPaise: gross, discountPaise: 0,
      taxAmountPaise: 0, netAmountPaise: gross, entryDate: date, accountCode: genAccountCode(ids),
      postedBy: 'sysuser', memo: status === 'void' ? 'Voided entry' : 'Not yet posted', status,
    });
  }
  return out;
}

// ─── dispatch ──────────────────────────────────────────────────────────────────

const SCENARIO_PROJECTORS: Readonly<Record<string, (rng: Rng, event: EconomicEvent, config: RunConfig) => ProjectedRow[]>> = {
  CLEAN_3WAY: projectCleanLike,
  TIMING_LAG_NORMAL: projectTimingLagNormal,
  FEE_NET_SETTLEMENT: projectFeeNetSettlement,
  MERCHANT_NAME_VARIANT: projectMerchantNameVariant,
  REF_MISSING_OR_TYPO: projectRefMissingOrTypo,
  MISSING_IN_LEDGER: projectMissingInLedger,
  MISSING_IN_BANK: projectMissingInBank,
  AMOUNT_TRUE_MISMATCH: projectAmountTrueMismatch,
  DUPLICATE_ROW: projectDuplicateRow,
  SPLIT_SETTLEMENT: projectSplitSettlement,
  REFUND_REVERSAL: projectRefundReversal,
  IDENTITY_DESTROYED: projectIdentityDestroyed,
  ORPHAN_NO_COUNTERPART: projectOrphanNoCounterpart,
  // UNSPLITTABLE_NET_BATCH is dispatched separately (projectUnsplittableEvent) —
  // it is the one scenario whose proof needs whole-dataset context, so index.ts
  // calls it directly rather than through this table.
};

/**
 * Project one event, deterministically, retry-safe via `attempt`.
 *
 * `attempt` folds into the derived sub-stream key, so `attempt: 0` and
 * `attempt: 1` for the SAME event produce genuinely different draws — this is
 * what lets the orchestrator retry a single §4 proof failure (`ORPHAN_NO_COUNTERPART`)
 * without touching any other event's rows. `UNSPLITTABLE_NET_BATCH` retries
 * through `projectUnsplittableEvent` instead, which narrows what `attempt`
 * touches even further — see that function's own note.
 */
export function projectEvent(
  rng: Rng, event: EconomicEvent, config: RunConfig, attempt = 0,
): ProjectedRow[] {
  const local = rng.derive(`project.event.${event.eventId}.${attempt}`);
  const projector = SCENARIO_PROJECTORS[event.scenario];
  if (projector === undefined) {
    throw new Error(`projectEvent: no projector registered for scenario ${event.scenario}`);
  }
  return projector(local, event, config);
}

/**
 * `UNSPLITTABLE_NET_BATCH`'s own entry point — returns the credit row
 * separately so the caller can prove it.
 *
 * `creditAttempt` retries ONLY the mystery credit (see `projectUnsplittableNetBatch`);
 * the gateway/ledger pair is always this event's `attempt: 0` draw, so a retry
 * never perturbs the gateway pool any other event's proof was checked against.
 */
export function projectUnsplittableEvent(
  rng: Rng, event: EconomicEvent, config: RunConfig, creditAttempt = 0,
): { rows: ProjectedRow[]; credit: BankRow } {
  const local = rng.derive(`project.event.${event.eventId}.0`);
  return projectUnsplittableNetBatch(local, event, config, creditAttempt);
}
