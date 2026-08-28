import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from './prng.js';
import {
  formatPlainRupees, formatMessyRupees, formatGatewayTimestamp, formatDDMMYYYY,
  formatMMDDYYYY, dayIsUnambiguous, genPaymentId, genOrderId, genRrn, genUtr,
  genSettlementId, genInvoiceNo, genEntryId, genAccountCode, typoTranspose, truncateMidToken,
} from './format.js';
import { parseMoney } from '../../apps/api/src/services/ingestion/money.js';
import { parseSourceDate } from '../../apps/api/src/services/ingestion/dates.js';
import { isWellFormedAnchor } from '../../apps/api/src/services/matching/anchors.js';

const SEED = 424_242;

/**
 * EVERY FORMATTER MUST ROUND-TRIP THROUGH THE ENGINE'S REAL PARSER. Not a
 * restatement of what "valid" means — the actual `parseMoney`/`parseSourceDate`
 * this project ships, called directly. A formatter that emits something the real
 * parser rejects or silently mangles is a bug the invariants elsewhere cannot see,
 * because by the time an invariant runs the value is already the typed number the
 * generator itself computed — the CSV text is the only place this class of bug
 * can hide.
 */
describe('money formatting round-trips through the real parser', () => {
  const amounts = [0, 1, 50, 99, 100, 12_345, 199_99, 20_000_00, 123_450, 4_82_110_00, 9_99_99_99_99];

  test('formatPlainRupees is exact for every amount', () => {
    for (const paise of amounts) {
      const parsed = parseMoney(formatPlainRupees(paise));
      assert.equal(parsed.ok, true, `formatPlainRupees(${paise}) failed to parse`);
      assert.equal((parsed as { ok: true; paise: number | null }).paise, paise);
    }
  });

  test('formatMessyRupees is exact across every style, many draws', () => {
    const rng = new Rng(SEED);
    for (let i = 0; i < 500; i += 1) {
      const paise = rng.pick(amounts);
      const text = formatMessyRupees(rng, paise);
      const parsed = parseMoney(text);
      assert.equal(parsed.ok, true, `"${text}" (from ${paise} paise) failed to parse`);
      assert.equal((parsed as { ok: true; paise: number | null }).paise, paise,
        `"${text}" round-tripped to the wrong value`);
    }
  });

  test('all three messy styles actually appear', () => {
    // A formatter that always draws the same style would leave money.ts's other
    // code paths (currency-symbol stripping, group-separator stripping) untested
    // by the generated data.
    const rng = new Rng(SEED);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const text = formatMessyRupees(rng, 123_450);
      if (text.includes('₹')) seen.add('symbol');
      else if (text.includes(',')) seen.add('grouped');
      else seen.add('plain');
    }
    assert.deepEqual([...seen].sort(), ['grouped', 'plain', 'symbol']);
  });

  test('a negative amount round-trips with its sign', () => {
    const parsed = parseMoney(formatPlainRupees(-4_711));
    assert.equal(parsed.ok, true);
    assert.equal((parsed as { ok: true; paise: number | null }).paise, -4_711);
  });

  test('the one-fractional-digit symbol variant is exercised and round-trips', () => {
    // formatMessyRupees pads a bare tens digit ("₹1234.5") specifically to
    // exercise money.ts's short-fraction path; confirm it actually fires.
    const rng = new Rng(SEED);
    let sawShortFraction = false;
    for (let i = 0; i < 300; i += 1) {
      const text = formatMessyRupees(rng, 123_450); // .50 -> "5" is eligible
      if (/₹\d+\.\d$/.test(text)) {
        sawShortFraction = true;
        const parsed = parseMoney(text);
        assert.equal(parsed.ok, true);
        assert.equal((parsed as { ok: true; paise: number | null }).paise, 123_450);
      }
    }
    assert.ok(sawShortFraction, 'the short-fraction symbol style never appeared in 300 draws');
  });
});

describe('date formatting round-trips through the declared-format parser', () => {
  const dates = ['2026-08-01', '2026-08-14', '2026-08-20', '2026-02-28', '2026-12-31'];

  test('formatGatewayTimestamp parses as YYYY-MM-DD HH:MM:SS', () => {
    for (const d of dates) {
      const text = formatGatewayTimestamp(d, 18, 42, 11);
      const result = parseSourceDate(text, 'YYYY-MM-DD HH:MM:SS');
      assert.equal(result.ok, true, `"${text}" failed to parse`);
      const value = (result as { ok: true; value: { businessDate: string } | null }).value;
      assert.equal(value?.businessDate, d);
    }
  });

  test('formatDDMMYYYY parses as DD-MM-YYYY', () => {
    for (const d of dates) {
      const result = parseSourceDate(formatDDMMYYYY(d), 'DD-MM-YYYY');
      assert.equal(result.ok, true);
      assert.equal((result as { ok: true; value: { businessDate: string } | null }).value?.businessDate, d);
    }
  });

  test('formatMMDDYYYY parses as MM/DD/YYYY', () => {
    for (const d of dates) {
      const result = parseSourceDate(formatMMDDYYYY(d), 'MM/DD/YYYY');
      assert.equal(result.ok, true);
      assert.equal((result as { ok: true; value: { businessDate: string } | null }).value?.businessDate, d);
    }
  });

  test('THE SAME CALENDAR DAY, THREE DIFFERENT STRINGS — the whole point of §2.3', () => {
    // '2026-08-14' must not look the same in all three formats, or the "declared,
    // never inferred" defect this dataset exists to exercise is not actually present.
    const d = '2026-08-14';
    const strings = [formatGatewayTimestamp(d, 0, 0, 0).slice(0, 10), formatDDMMYYYY(d), formatMMDDYYYY(d)];
    assert.equal(new Set(strings).size, 3, `all three formats read as "${strings[0]}"`);
  });

  test('dayIsUnambiguous matches the actual ambiguity of MM/DD vs DD/MM', () => {
    assert.equal(dayIsUnambiguous('2026-08-14'), true);   // 14 can't be a month
    assert.equal(dayIsUnambiguous('2026-08-12'), false);  // 12 could be read as a month
    assert.equal(dayIsUnambiguous('2026-08-01'), false);
  });
});

describe('identifiers', () => {
  test('payment_id and order_id carry their prefix and length', () => {
    const rng = new Rng(SEED);
    for (let i = 0; i < 50; i += 1) {
      assert.match(genPaymentId(rng), /^pay_[A-Za-z0-9]{14}$/);
      assert.match(genOrderId(rng), /^order_[A-Za-z0-9]{14}$/);
      assert.match(genSettlementId(rng), /^setl_[A-Za-z0-9]{14}$/);
    }
  });

  test('genRrn is always a well-formed 12-digit anchor', () => {
    const rng = new Rng(SEED);
    for (let i = 0; i < 200; i += 1) {
      const rrn = genRrn(rng);
      assert.match(rrn, /^\d{12}$/);
      assert.equal(isWellFormedAnchor('rrn', rrn), true, `${rrn} is not well-formed per anchors.ts`);
    }
  });

  test('genUtr length varies within 16-22, per §2.2', () => {
    const rng = new Rng(SEED);
    const lengths = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const utr = genUtr(rng);
      assert.ok(utr.length >= 16 && utr.length <= 22, `utr length ${utr.length}`);
      lengths.add(utr.length);
    }
    assert.ok(lengths.size > 1, 'every UTR came out the same length');
  });

  test('genInvoiceNo and genEntryId are unique per sequence number', () => {
    assert.equal(genInvoiceNo(1), 'INV/2026/00001');
    assert.equal(genInvoiceNo(123), 'INV/2026/00123');
    assert.equal(genEntryId(7), 'JE-000007');
    assert.notEqual(genInvoiceNo(1), genInvoiceNo(2));
  });

  test('genAccountCode stays in the ledger revenue range', () => {
    const rng = new Rng(SEED);
    for (let i = 0; i < 50; i += 1) {
      const code = Number(genAccountCode(rng));
      assert.ok(code >= 4000 && code <= 4999, `account code ${code}`);
    }
  });

  test('IDs are DETERMINISTIC in the seed', () => {
    assert.equal(genPaymentId(new Rng(SEED)), genPaymentId(new Rng(SEED)));
    assert.equal(genRrn(new Rng(SEED)), genRrn(new Rng(SEED)));
  });
});

describe('typoTranspose — REF_TYPO', () => {
  test('the result differs from the input and is the same length', () => {
    const rng = new Rng(SEED);
    for (let i = 0; i < 50; i += 1) {
      const original = genPaymentId(rng);
      const typo = typoTranspose(rng, original);
      assert.notEqual(typo, original, `"${original}" was not actually mutated`);
      assert.equal(typo.length, original.length);
      assert.deepEqual([...typo].sort(), [...original].sort(), 'characters must be a permutation, not a substitution');
    }
  });

  test('a well-formed RRN typo is still 12 digits but a DIFFERENT value', () => {
    // The whole point: the corrupted anchor is still shape-valid, so the engine's
    // exact tier has to actually COMPARE it and fail, not reject it on shape.
    const rng = new Rng(SEED);
    for (let i = 0; i < 50; i += 1) {
      const rrn = genRrn(rng);
      const typo = typoTranspose(rng, rrn);
      assert.match(typo, /^\d{12}$/);
      assert.notEqual(typo, rrn);
    }
  });

  test('strings under length 2 are returned unchanged rather than throwing', () => {
    assert.equal(typoTranspose(new Rng(SEED), ''), '');
    assert.equal(typoTranspose(new Rng(SEED), 'A'), 'A');
  });
});

describe('truncateMidToken — DESC_TRUNCATED', () => {
  test('the result is a strict, non-trivial prefix', () => {
    const rng = new Rng(SEED);
    const desc = 'NEFT-SETL-AMZN RETAIL-234567890123-BATCH12';
    const cut = truncateMidToken(rng, desc);
    assert.ok(cut.length > 0);
    assert.ok(cut.length < desc.length, 'truncation did not actually shorten the description');
    assert.equal(desc.startsWith(cut), true);
  });

  test('it removes the trailing anchor often enough to matter', () => {
    const rng = new Rng(SEED);
    const desc = 'NEFT-SETL-AMZN RETAIL-234567890123-BATCH12';
    let anchorSurvived = 0;
    for (let i = 0; i < 100; i += 1) {
      if (truncateMidToken(rng, desc).includes('234567890123')) anchorSurvived += 1;
    }
    assert.ok(anchorSurvived < 40, `the RRN survived truncation ${anchorSurvived}/100 times`);
  });
});
