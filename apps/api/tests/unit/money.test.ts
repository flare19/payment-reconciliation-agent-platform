import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, formatPaise, MoneyWarning } from '../../src/services/ingestion/money.js';

/**
 * Table-driven, one case per documented defect (testing-strategy §1.1).
 * A parser bug produces a number rather than an error, so these assert exact
 * values — never "roughly".
 */

function paise(raw: string | null | undefined): number | null {
  const r = parseMoney(raw);
  assert.ok(r.ok, `expected "${raw}" to parse, got: ${r.ok ? '' : r.error}`);
  return r.paise;
}

describe('parseMoney', () => {
  test('the documented defect table', () => {
    assert.equal(paise('1,234.50'), 123450);
    assert.equal(paise('₹1234.5'), 123450);
    assert.equal(paise('1234.50'), 123450);
    assert.equal(paise(' 1234.50 '), 123450);
    assert.equal(paise('(1,234.50)'), -123450);
    assert.equal(paise('1234.567'), 123457);   // round-half-up at paise
    assert.equal(paise(''), null);
    assert.equal(paise(null), null);
  });

  test('Indian lakh grouping — two-digit groups above the hundreds', () => {
    // A rule expecting groups of three rejects or mis-reads an ordinary Indian
    // amount. parseFloat("1,23,456.50") returns 1 — confidently, and wrong.
    assert.equal(paise('1,23,456.50'), 12345650);
    assert.equal(paise('12,34,567.89'), 123456789);
    assert.equal(paise('1,00,00,000.00'), 1000000000);
    assert.notEqual(paise('1,23,456.50'), Math.round(parseFloat('1,23,456.50') * 100));
  });

  test('THE FLOAT TRAP: cases where Math.round(parseFloat(x)*100) is wrong', () => {
    // 1.005 * 100 === 100.49999999999999 in IEEE-754, so the naive version rounds
    // DOWN to 100 where half-up requires 101. This test is the reason money.ts
    // does string arithmetic; if someone "simplifies" it, this fails.
    assert.equal(paise('1.005'), 101);
    assert.equal(Math.round(parseFloat('1.005') * 100), 100); // documents the wrong answer

    assert.equal(paise('8.165'), 817);
    assert.equal(Math.round(parseFloat('8.165') * 100), 816);

    assert.equal(paise('1234.565'), 123457);
  });

  test('rounding is half-up on magnitude, and symmetric across sign', () => {
    assert.equal(paise('0.494'), 49);
    assert.equal(paise('0.495'), 50);
    assert.equal(paise('0.4999'), 50);   // third digit decides: 0.4999 > 0.495
    assert.equal(paise('0.4949'), 49);
    // Symmetry matters: an asymmetric rule would make a reversal fail to
    // reconcile against its original by exactly one paisa.
    assert.equal(paise('(1234.567)'), -123457);
    assert.equal(paise('-1234.567'), -123457);
  });

  test('currency markers and separators', () => {
    assert.equal(paise('Rs. 500'), 50000);
    assert.equal(paise('INR 1,234.50'), 123450);
    assert.equal(paise('₹ 1,23,456'), 12345600);
    assert.equal(paise('1234'), 123400);
    assert.equal(paise('1234.'), 123400);
    assert.equal(paise('0'), 0);
    assert.equal(paise('0.00'), 0);
  });

  test('unparseable content rejects the ROW rather than defaulting to zero', () => {
    // Silently defaulting a bad amount to 0 would make a broken row look like a
    // free transaction and quietly enter the reconcilable population (ADR-046).
    for (const bad of ['abc', '1.2.3', '1e3', 'Infinity', 'NaN', '--5', '(-5)', '12,34,ab']) {
      const r = parseMoney(bad);
      assert.equal(r.ok, false, `"${bad}" must be rejected, not coerced`);
    }
  });

  test('warnings record what the parser had to assume', () => {
    const symbol = parseMoney('₹1234.50');
    assert.ok(symbol.ok && symbol.warnings.includes(MoneyWarning.HAD_CURRENCY_SYMBOL));

    const rounded = parseMoney('1234.567');
    assert.ok(rounded.ok && rounded.warnings.includes(MoneyWarning.ROUNDED_TO_PAISE));

    const negative = parseMoney('(1234.50)');
    assert.ok(negative.ok && negative.warnings.includes(MoneyWarning.ACCOUNTING_NEGATIVE));

    const blank = parseMoney('');
    assert.ok(blank.ok && blank.warnings.includes(MoneyWarning.MISSING));

    // An exact value should not accumulate noise warnings.
    const clean = parseMoney('1234.50');
    assert.ok(clean.ok && !clean.warnings.includes(MoneyWarning.ROUNDED_TO_PAISE));
  });

  test('precision holds at realistic Indian payment scale', () => {
    assert.equal(paise('99,99,99,999.99'), 99999999999);  // ~₹100 crore
    const r = parseMoney('999999999999999999999.99');
    assert.equal(r.ok, false, 'beyond safe-integer paise must fail loudly, not silently truncate');
  });
});

describe('formatPaise', () => {
  test('Indian digit grouping: last three, then twos', () => {
    assert.equal(formatPaise(123450), '₹1,234.50');
    assert.equal(formatPaise(12345650), '₹1,23,456.50');
    assert.equal(formatPaise(123456789), '₹12,34,567.89');
    assert.equal(formatPaise(1000000000), '₹1,00,00,000.00');
    assert.equal(formatPaise(50000), '₹500.00');
    assert.equal(formatPaise(5), '₹0.05');
    assert.equal(formatPaise(0), '₹0.00');
    assert.equal(formatPaise(-123450), '-₹1,234.50');
  });

  test('round-trips with parseMoney', () => {
    for (const v of [0, 5, 50, 123450, 12345650, 123456789, 1000000000, -123450]) {
      assert.equal(paise(formatPaise(v)), v, `round-trip failed for ${v}`);
    }
  });
});
