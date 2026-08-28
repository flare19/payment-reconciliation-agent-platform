import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { readCsv, CsvParseError } from '../../src/services/ingestion/csv.js';
import { extractDescriptionAnchors, anchorStrengthOf } from '../../src/services/ingestion/anchor-extraction.js';
import { parseGatewayFile } from '../../src/services/ingestion/gateway-parser.js';
import { parseBankFile } from '../../src/services/ingestion/bank-parser.js';
import { parseLedgerFile } from '../../src/services/ingestion/ledger-parser.js';
import { ingestSources } from '../../src/services/ingestion/index.js';

const RUN_ID = '00000000-0000-0000-0000-000000000000';
const FIX = new URL('../../../../data/fixtures/holdout/', import.meta.url).pathname;
const TRUTH = new URL('../../../../data/truth/holdout_seed_90210.json', import.meta.url).pathname;

const holdout = {
  gateway: readFileSync(FIX + 'gateway_export.csv', 'utf8'),
  bank: readFileSync(FIX + 'bank_settlement.csv', 'utf8'),
  ledger: readFileSync(FIX + 'merchant_ledger.csv', 'utf8'),
};

// ─────────────────────────────────────────────────────────────────────────────
// readCsv — the one place source_row_number is assigned.
// ─────────────────────────────────────────────────────────────────────────────

describe('readCsv', () => {
  test('first data row is sourceRowNumber 1; the header is row 0', () => {
    const doc = readCsv('a,b,c\nx,y,z\np,q,r\n');
    assert.deepEqual(doc.header, ['a', 'b', 'c']);
    assert.equal(doc.rows.length, 2);
    assert.equal(doc.rows[0]!.sourceRowNumber, 1);
    assert.equal(doc.rows[1]!.sourceRowNumber, 2);
  });

  test('a ragged row is KEPT in place, not dropped — numbering never shifts', () => {
    const doc = readCsv('a,b,c\n1,2,3\n4,5\n6,7,8\n');
    assert.equal(doc.rows.length, 3);
    assert.deepEqual(doc.rows.map((r) => r.sourceRowNumber), [1, 2, 3]);
    assert.equal(doc.rows[1]!.fields.length, 2); // the short row, still row 2
    assert.deepEqual(doc.rows[2]!.fields, ['6', '7', '8']); // row 3 unaffected
  });

  test('a blank interior line is KEPT (as a 1-field row) so the rows after it keep their numbers', () => {
    const doc = readCsv('a,b\n1,2\n\n3,4\n');
    assert.deepEqual(doc.rows.map((r) => r.sourceRowNumber), [1, 2, 3]);
    assert.deepEqual(doc.rows[1]!.fields, ['']);
    assert.deepEqual(doc.rows[2]!.fields, ['3', '4']);
  });

  test('a single trailing newline does not create a phantom row', () => {
    assert.equal(readCsv('a,b\n1,2\n').rows.length, 1);
  });

  test('quoted fields containing commas do not inflate the field count', () => {
    const doc = readCsv('a,b,c\n1,"2,000.50",3\n');
    assert.deepEqual(doc.rows[0]!.fields, ['1', '2,000.50', '3']);
  });

  test('raw carries the original bytes of the row, newline stripped', () => {
    const doc = readCsv('a,b\n1,"x,y"\n');
    assert.equal(doc.rows[0]!.raw, '1,"x,y"');
  });

  test('an unterminated quote fails the whole file (matching-engine §12)', () => {
    assert.throws(() => readCsv('a,b\n1,"oops\n'), CsvParseError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// source_row_number — the join key. This is what an off-by-one silently breaks.
// ─────────────────────────────────────────────────────────────────────────────

describe('source_row_number integrity', () => {
  const result = ingestSources({ runId: RUN_ID, files: holdout });

  for (const [source, csv, expected] of [
    ['gateway', holdout.gateway, 323],
    ['bank', holdout.bank, 301],
    ['ledger', holdout.ledger, 296],
  ] as const) {
    test(`${source}: every physical data row is numbered exactly once, 1..N (N=${expected})`, () => {
      const dataLineCount = csv.trimEnd().split('\n').length - 1; // minus header
      assert.equal(dataLineCount, expected, 'fixture sanity');

      const numbers = [
        ...result.transactions.filter((t) => t.sourceSystem === source).map((t) => t.sourceRowNumber),
        ...result.rejectedRows.filter((r) => r.sourceSystem === source).map((r) => r.rowNumber),
      ].sort((a, b) => a - b);

      assert.equal(numbers.length, expected, 'accepted + rejected must account for every data row');
      assert.equal(new Set(numbers).size, expected, 'no row number is used twice');
      assert.deepEqual(numbers, Array.from({ length: expected }, (_, i) => i + 1), 'contiguous 1..N, no gap');
    });
  }

  test('the row a transaction claims is the row the answer key points at', () => {
    const key = JSON.parse(readFileSync(TRUTH, 'utf8')) as {
      events: {
        canonical: { amountPaise: number };
        projections: { sourceSystem: 'gateway' | 'bank' | 'ledger'; sourceRowNumber: number; defects: string[] }[];
      }[];
    };
    const at = (source: string, n: number) =>
      result.transactions.find((t) => t.sourceSystem === source && t.sourceRowNumber === n);

    let checkedGatewayAmounts = 0;
    let checkedRefLinks = 0;

    for (const ev of key.events) {
      const gw = ev.projections.find((p) => p.sourceSystem === 'gateway');
      for (const p of ev.projections) {
        const txn = at(p.sourceSystem, p.sourceRowNumber);
        assert.ok(txn, `no ${p.sourceSystem} txn at row ${p.sourceRowNumber} (event projection lost)`);

        // Gateway amount must reconstruct the canonical amount (unless the event
        // deliberately breaks it), proving the row we indexed is the right one.
        if (p.sourceSystem === 'gateway'
          && !ev.projections.some((x) => x.defects.includes('AMOUNT_TRUE_MISMATCH'))) {
          assert.equal(txn!.amountPaise, ev.canonical.amountPaise,
            `gateway row ${p.sourceRowNumber} amount != canonical`);
          checkedGatewayAmounts += 1;
        }

        // A clean ledger row's gateway_ref must be the referenced gateway's
        // payment_id — a second, independent check that both indices are aligned.
        if (p.sourceSystem === 'ledger' && gw
          && !p.defects.includes('REF_MISSING') && !p.defects.includes('REF_TYPO')
          && !gw.defects.includes('REF_MISSING')) {
          const ledgerTxn = at('ledger', p.sourceRowNumber)!;
          const gatewayTxn = at('gateway', gw.sourceRowNumber)!;
          assert.equal(ledgerTxn.rawPayload['gateway_ref'], gatewayTxn.rawPayload['payment_id'],
            `ledger row ${p.sourceRowNumber} gateway_ref != gateway row ${gw.sourceRowNumber} payment_id`);
          checkedRefLinks += 1;
        }
      }
    }
    assert.ok(checkedGatewayAmounts > 200, `expected many amount checks, ran ${checkedGatewayAmounts}`);
    assert.ok(checkedRefLinks > 150, `expected many ref-link checks, ran ${checkedRefLinks}`);
  });

  test('parsing is stable across two runs (ids aside)', () => {
    const a = ingestSources({ runId: RUN_ID, files: holdout });
    const b = ingestSources({ runId: RUN_ID, files: holdout });
    const strip = (r: typeof a) => r.transactions.map(({ id, ...rest }) => rest);
    assert.deepEqual(strip(a), strip(b));
    assert.equal(a.referenceDate, b.referenceDate);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exclusion (S3) — kept, counted, marked; never matched-and-failed.
// ─────────────────────────────────────────────────────────────────────────────

describe('exclusion rules', () => {
  const result = ingestSources({ runId: RUN_ID, files: holdout });

  test('gateway failed / authorized are excluded, not reconcilable', () => {
    for (const t of result.transactions.filter((t) => t.sourceSystem === 'gateway')) {
      if (t.statusRaw === 'failed') assert.equal(t.statusNorm, 'excluded_failed');
      if (t.statusRaw === 'authorized') assert.equal(t.statusNorm, 'excluded_authorized');
      if (t.statusRaw === 'captured') assert.equal(t.statusNorm, 'reconcilable');
      if (t.statusNorm === 'reconcilable') assert.ok(['captured', 'refunded'].includes(t.statusRaw));
    }
    assert.ok(result.transactions.some((t) => t.statusNorm === 'excluded_failed'));
    assert.ok(result.transactions.some((t) => t.statusNorm === 'excluded_authorized'));
  });

  test('ledger draft / void are excluded; only posted is reconcilable', () => {
    for (const t of result.transactions.filter((t) => t.sourceSystem === 'ledger')) {
      if (t.statusRaw === 'draft') assert.equal(t.statusNorm, 'excluded_draft');
      if (t.statusRaw === 'void') assert.equal(t.statusNorm, 'excluded_void');
      if (t.statusNorm === 'reconcilable') assert.equal(t.statusRaw, 'posted');
    }
    assert.ok(result.transactions.some((t) => t.statusNorm === 'excluded_draft'));
    assert.ok(result.transactions.some((t) => t.statusNorm === 'excluded_void'));
  });

  test('bank FEE rows are excluded at ingestion (ADR-036); other types are not', () => {
    const csv = [
      'utr,value_date,posting_date,description,credit_amount,debit_amount,closing_balance,bank_ref_no,transaction_type',
      'UTR1,01-08-2026,01-08-2026,NEFT-SETL-ACME-BATCH1,100.00,,500.00,,SETTLEMENT',
      'UTR2,01-08-2026,01-08-2026,FEE-GATEWAY-CHG,,12.00,488.00,,FEE',
      'UTR3,02-08-2026,02-08-2026,CHGBK-DISPUTE-123456789012,,50.00,438.00,,CHARGEBACK',
    ].join('\n') + '\n';
    const { transactions, rejectedRows } = parseBankFile({ runId: RUN_ID, text: csv });
    assert.equal(rejectedRows.length, 0);
    assert.equal(transactions[0]!.statusNorm, 'reconcilable');
    assert.equal(transactions[1]!.statusNorm, 'excluded_non_reconcilable'); // FEE
    assert.equal(transactions[2]!.statusNorm, 'reconcilable'); // CHARGEBACK stays in
    assert.equal(transactions[1]!.direction, 'debit');
  });

  test('counts.excluded is the number of non-reconcilable transactions', () => {
    const excluded = result.transactions.filter((t) => t.statusNorm !== 'reconcilable').length;
    assert.equal(result.counts.excluded, excluded);
    assert.equal(
      result.counts.gateway + result.counts.bank + result.counts.ledger,
      result.transactions.length,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rejected-row capture (ADR-046) — an unreadable row is not a transaction and
// not an exception, and it still holds its place in the numbering.
// ─────────────────────────────────────────────────────────────────────────────

describe('rejected-row capture', () => {
  const header =
    'payment_id,order_id,method,status,amount,currency,fee,tax,net_amount,created_at,captured_at,merchant_name,customer_email,rrn,settlement_id,notes';
  const good = (id: string, amount = '100.00', created = '2026-08-01 10:00:00') =>
    `${id},order_x,upi,captured,${amount},INR,2.00,0.36,97.64,${created},,ACME,,,,`;

  test('a wrong-width row, a bad amount, a bad date, and a blank line each reject — and rows after keep numbering', () => {
    const csv = [
      header,
      good('pay_00000000000001'),        // row 1  ok
      'pay_00000000000002,only,three',    // row 2  ragged -> reject
      good('pay_00000000000003', 'N/A'),  // row 3  unparseable amount -> reject
      good('pay_00000000000004', '100.00', '2026-13-40 99:99:99'), // row 4 bad date -> reject
      '',                                 // row 5  blank -> reject
      good('pay_00000000000006'),         // row 6  ok
    ].join('\n') + '\n';

    const { transactions, rejectedRows } = parseGatewayFile({ runId: RUN_ID, text: csv });

    assert.deepEqual(transactions.map((t) => t.sourceRowNumber), [1, 6]);
    assert.deepEqual(rejectedRows.map((r) => r.rowNumber), [2, 3, 4, 5]);
    assert.equal(transactions[1]!.rawPayload['payment_id'], 'pay_00000000000006');

    for (const r of rejectedRows) {
      assert.equal(r.sourceSystem, 'gateway');
      assert.ok(r.error.length > 0);
      assert.ok(typeof r.rawLine === 'string');
    }
    // The bad-date row's raw line is preserved verbatim for the UI.
    assert.match(rejectedRows[2]!.rawLine, /2026-13-40/);
  });

  test('rejected rows never appear as transactions and drive counts.rejected', () => {
    const csv = [header, good('pay_a0000000000001'), 'garbage,row', good('pay_a0000000000003')].join('\n') + '\n';
    const r = parseGatewayFile({ runId: RUN_ID, text: csv });
    assert.equal(r.transactions.length, 2);
    assert.equal(r.rejectedRows.length, 1);
    assert.equal(r.rejectedRows[0]!.rowNumber, 2);

    const agg = ingestSources({
      runId: RUN_ID,
      files: { gateway: csv, bank: 'utr,value_date,posting_date,description,credit_amount,debit_amount,closing_balance,bank_ref_no,transaction_type\n', ledger: 'entry_id,invoice_no,gateway_ref,customer_name,gross_amount,discount,tax_amount,net_amount,entry_date,account_code,posted_by,memo,status\n' },
    });
    assert.equal(agg.counts.rejected, 1);
  });

  test('a blank required money field rejects rather than defaulting to zero', () => {
    const csv = [header, `pay_b0000000000001,,upi,captured,,INR,,,,2026-08-01 10:00:00,,ACME,,,,`].join('\n') + '\n';
    const r = parseGatewayFile({ runId: RUN_ID, text: csv });
    assert.equal(r.transactions.length, 0);
    assert.equal(r.rejectedRows.length, 1);
    assert.match(r.rejectedRows[0]!.error, /amount/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anchor extraction & strength (schema §3.1 / §3.2).
// ─────────────────────────────────────────────────────────────────────────────

describe('anchor extraction', () => {
  test('description anchors pull reference-shaped tokens only, never merchant words', () => {
    assert.deepEqual(
      extractDescriptionAnchors('UPI-SETL-FSN E-COMMERCE-510996260123-setl_xot9xgPg5duO6q-BATCH81'),
      ['510996260123', 'setl_xot9xgPg5duO6q'],
    );
    assert.deepEqual(extractDescriptionAnchors('NEFT-SE'), []); // truncated to nothing
    assert.deepEqual(extractDescriptionAnchors('MISC-CREDIT-ABCDEFGH'), []);
    assert.deepEqual(extractDescriptionAnchors('CHGBK-DISPUTE-834729101827'), ['834729101827']);
    assert.deepEqual(extractDescriptionAnchors('NEFT-SETL-AMZN RET'), []); // 11-digit / no ref survived
  });

  test('anchor strength follows schema §3.2', () => {
    assert.equal(anchorStrengthOf({ payment_id: 'pay_QK29fT10aXbZ81' }), 'strong');
    assert.equal(anchorStrengthOf({ settlement_id: 'setl_QK2AAb91xxKK01' }), 'strong');
    assert.equal(anchorStrengthOf({ rrn: '234567890123' }), 'strong');
    assert.equal(anchorStrengthOf({ rrn: '2345' }), 'none'); // malformed rrn is not strong
    assert.equal(anchorStrengthOf({ order_id: 'order_x' }), 'weak');
    assert.equal(anchorStrengthOf({ bank_ref_no: '99', utr: 'U1' }), 'weak');
    assert.equal(anchorStrengthOf({ extracted_from_description: ['234567890123'] }), 'weak');
    assert.equal(anchorStrengthOf({ utr: 'U1' }), 'none'); // utr alone never lifts above none
    assert.equal(anchorStrengthOf({ entry_id: 'JE-000001', invoice_no: 'INV/2026/1' }), 'none');
  });

  test('holdout: gateway strong except the 9 identity-destroyed rows; bank never strong', () => {
    const r = ingestSources({ runId: RUN_ID, files: holdout });
    const g = r.transactions.filter((t) => t.sourceSystem === 'gateway');
    assert.equal(g.filter((t) => t.anchorStrength === 'none').length, 9);
    assert.ok(g.filter((t) => t.anchorStrength === 'strong').length > 300);
    assert.equal(r.transactions.filter((t) => t.sourceSystem === 'bank' && t.anchorStrength === 'strong').length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Normalization carried through (S2).
// ─────────────────────────────────────────────────────────────────────────────

describe('normalization', () => {
  const r = ingestSources({ runId: RUN_ID, files: holdout });

  test('money: messy rupee strings become integer paise', () => {
    for (const t of r.transactions) {
      assert.ok(Number.isSafeInteger(t.amountPaise));
      if (t.feePaise !== null) assert.ok(Number.isSafeInteger(t.feePaise));
      if (t.netAmountPaise !== null) assert.ok(Number.isSafeInteger(t.netAmountPaise));
    }
    // A row that carried a ₹ symbol is flagged.
    assert.ok(r.transactions.some((t) => t.ingestWarnings.includes('AMOUNT_HAD_CURRENCY_SYMBOL')));
  });

  test('dates: three formats, one IST business date; gateway carries a UTC instant', () => {
    for (const t of r.transactions) {
      assert.match(t.txnDate, /^\d{4}-\d{2}-\d{2}$/);
      if (t.sourceSystem === 'gateway') assert.ok(t.txnTimestamp && t.txnTimestamp.endsWith('Z'));
      else assert.equal(t.txnTimestamp, null);
    }
    assert.ok(r.transactions.some((t) => t.ingestWarnings.includes('DATE_ASSUMED_IST')));
    // The MM/DD/YYYY ledger format is declared, never inferred: a day > 12 proves order.
    const ledgerAug = r.transactions.find(
      (t) => t.sourceSystem === 'ledger' && t.rawPayload['entry_date']?.startsWith('08/1'),
    );
    assert.ok(ledgerAug && ledgerAug.txnDate.startsWith('2026-08-'));
  });

  test('direction: refunded gateway is a debit, captured is a credit, ledger is always credit', () => {
    for (const t of r.transactions.filter((t) => t.sourceSystem === 'gateway')) {
      if (t.statusRaw === 'refunded') assert.equal(t.direction, 'debit');
      if (t.statusRaw === 'captured') assert.equal(t.direction, 'credit');
    }
    assert.ok(r.transactions.filter((t) => t.sourceSystem === 'gateway' && t.direction === 'debit').length > 0);
    assert.ok(r.transactions.filter((t) => t.sourceSystem === 'ledger').every((t) => t.direction === 'credit'));
    assert.ok(r.transactions.filter((t) => t.sourceSystem === 'bank' && t.direction === 'debit').length > 0);
  });

  test('counterparty_norm applied per source; counterparty_key deferred to S7', () => {
    // Bank description blobs get their rail scaffolding stripped from the front
    // (normalizeBankDescription); the leading UPI-/SETL-/NEFT- must be gone.
    const bank = r.transactions.find(
      (t) => t.sourceSystem === 'bank' && /^(UPI|SETL|NEFT|IMPS)-/.test(t.counterpartyRaw ?? ''),
    );
    assert.ok(bank && bank.counterpartyNorm);
    assert.doesNotMatch(bank!.counterpartyNorm!, /^(UPI|SETL|NEFT|IMPS)\b/);
    assert.notEqual(bank!.counterpartyNorm, bank!.counterpartyRaw);

    // Gateway/ledger use the plain counterparty normalizer (uppercased).
    const gw = r.transactions.find((t) => t.sourceSystem === 'gateway' && t.counterpartyRaw !== null)!;
    assert.equal(gw.counterpartyNorm, gw.counterpartyNorm!.toUpperCase());

    // counterparty_key is only set once Tier 1.5 runs.
    assert.ok(r.transactions.every((t) => t.counterpartyKey === null));
  });

  test('raw_payload round-trips every original column', () => {
    const header = holdout.gateway.split('\n')[0]!.split(',');
    const g = r.transactions.find((t) => t.sourceSystem === 'gateway')!;
    assert.deepEqual(Object.keys(g.rawPayload).sort(), [...header].sort());
  });

  test('gateway net_amount is derived when blank but fee and tax are present', () => {
    const csv = [
      'payment_id,order_id,method,status,amount,currency,fee,tax,net_amount,created_at,captured_at,merchant_name,customer_email,rrn,settlement_id,notes',
      'pay_c0000000000001,,upi,captured,1000.00,INR,20.00,3.60,,2026-08-01 10:00:00,,ACME,,,,',
    ].join('\n') + '\n';
    const { transactions } = parseGatewayFile({ runId: RUN_ID, text: csv });
    assert.equal(transactions[0]!.netAmountPaise, 100000 - 2000 - 360);
    assert.ok(transactions[0]!.ingestWarnings.includes('NET_AMOUNT_DERIVED'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate shape.
// ─────────────────────────────────────────────────────────────────────────────

describe('ingestSources aggregate', () => {
  const r = ingestSources({ runId: RUN_ID, files: holdout });

  test('reference date is MAX(txnDate) across all ingested rows (ADR-039)', () => {
    const max = r.transactions.reduce((m, t) => (t.txnDate > m ? t.txnDate : m), '0000-00-00');
    assert.equal(r.referenceDate, max);
    assert.equal(r.referenceDate, '2026-08-21');
  });

  test('transactions come out in canonical order: gateway, then bank, then ledger, each 1..N', () => {
    const order = r.transactions.map((t) => t.sourceSystem);
    const firstBank = order.indexOf('bank');
    const firstLedger = order.indexOf('ledger');
    assert.ok(order.lastIndexOf('gateway') < firstBank);
    assert.ok(firstBank < firstLedger);
    for (const s of ['gateway', 'bank', 'ledger'] as const) {
      const nums = r.transactions.filter((t) => t.sourceSystem === s).map((t) => t.sourceRowNumber);
      assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
    }
  });

  test('every transaction carries the run id and a source file', () => {
    for (const t of r.transactions) {
      assert.equal(t.runId, RUN_ID);
      assert.ok(t.sourceFile.endsWith('.csv'));
      assert.ok(t.externalId.length > 0);
    }
  });

  test('holdout parses with zero rejected rows and the documented record counts', () => {
    assert.deepEqual(
      { gateway: r.counts.gateway, bank: r.counts.bank, ledger: r.counts.ledger },
      { gateway: 323, bank: 301, ledger: 296 },
    );
    assert.equal(r.counts.rejected, 0);
    assert.equal(r.transactions.length, 920);
  });
});
