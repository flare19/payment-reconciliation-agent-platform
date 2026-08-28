import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCounterparty, normalizeBankDescription,
} from '../../src/services/ingestion/normalize.js';

describe('normalizeCounterparty', () => {
  test('the worked example from schema.md §3.3', () => {
    assert.equal(normalizeCounterparty('Amazon Retail India Pvt Ltd'), 'AMAZON RETAIL');
    assert.equal(normalizeCounterparty('AMZN'), 'AMZN');
  });

  test('normalization deliberately does NOT close the alias gap', () => {
    // If these ever became equal, learned_aliases would have nothing to learn and
    // the whole leverage story would be measuring nothing. The residual gap is
    // the feature (ADR-012).
    assert.notEqual(
      normalizeCounterparty('AMZN'),
      normalizeCounterparty('Amazon Retail India Pvt Ltd'),
    );
  });

  test('variants that SHOULD collapse, do', () => {
    const expected = 'AMAZON RETAIL';
    for (const variant of [
      'Amazon Retail', 'AMAZON RETAIL', '  amazon   retail  ',
      'Amazon-Retail', 'Amazon, Retail.', 'Amazon Retail Pvt. Ltd.',
      'Amazon Retail India Private Limited', 'Amazon/Retail',
    ]) {
      assert.equal(normalizeCounterparty(variant), expected, `failed for "${variant}"`);
    }
  });

  test('trailing legal suffixes strip repeatedly, not once', () => {
    // 'INDIA PVT LTD' needs three passes. A single-pass implementation leaves
    // 'AMAZON RETAIL INDIA PVT', which then fails to match 'AMAZON RETAIL'.
    assert.equal(normalizeCounterparty('Foo India Pvt Ltd'), 'FOO');
    assert.equal(normalizeCounterparty('Foo LLP'), 'FOO');
    assert.equal(normalizeCounterparty('Foo Corp Inc'), 'FOO');
  });

  test('a name made entirely of suffixes never normalises to empty', () => {
    // An empty counterparty_key would collide with every other empty one, turning
    // a missing name into a false match on a component meant to be evidence.
    assert.equal(normalizeCounterparty('India'), 'INDIA');
    assert.equal(normalizeCounterparty('CO'), 'CO');
    assert.equal(normalizeCounterparty('Ltd'), 'LTD');
  });

  test('blank and punctuation-only input yields null, not an empty string', () => {
    assert.equal(normalizeCounterparty(''), null);
    assert.equal(normalizeCounterparty('   '), null);
    assert.equal(normalizeCounterparty('---'), null);
    assert.equal(normalizeCounterparty(null), null);
    assert.equal(normalizeCounterparty(undefined), null);
  });

  test('NFKC folds compatibility forms', () => {
    assert.equal(normalizeCounterparty('ＡＭＺＮ'), 'AMZN');
  });

  test('is deterministic and idempotent', () => {
    // Idempotence matters: counterparty_key is re-normalised after alias
    // substitution, so a non-idempotent rule would drift between tiers.
    const once = normalizeCounterparty('Amazon Retail India Pvt Ltd')!;
    assert.equal(normalizeCounterparty(once), once);
  });
});

describe('normalizeBankDescription', () => {
  test('strips rail scaffolding from a real description blob', () => {
    assert.equal(
      normalizeBankDescription('NEFT-SETL-AMZN RETAIL-234567890123-BATCH12'),
      'AMZN RETAIL',
    );
  });

  test('rail prefixes strip repeatedly from the front', () => {
    assert.equal(normalizeBankDescription('NEFT UPI SETL FOO'), 'FOO');
    assert.equal(normalizeBankDescription('IMPS FOO'), 'FOO');
    assert.equal(normalizeBankDescription('SETTLEMENT FOO BAR'), 'FOO BAR');
  });

  test('trailing batch tokens and bare reference numbers are dropped', () => {
    // A batch id is not part of a merchant's name; leaving it in would make two
    // settlements for the same merchant look like different parties.
    assert.equal(normalizeBankDescription('SETL FOO BATCH12'), 'FOO');
    assert.equal(normalizeBankDescription('SETL FOO 234567890123'), 'FOO');
    // The anchor component already scores reference numbers properly, so the
    // counterparty component should score words.
    assert.equal(normalizeBankDescription('NEFT-FOO BAR-9876543210-BATCH01'), 'FOO BAR');
  });

  test('a description that is only scaffolding yields a rail word or null, never ""', () => {
    // A lone rail word is kept: it is at least a word, and the empty string would
    // collide with every other empty one and turn a missing name into a false
    // match on a component that is meant to be evidence.
    assert.equal(normalizeBankDescription('NEFT'), 'NEFT');
    // A description that is nothing but reference tokens carries no counterparty,
    // and `null` says so honestly (issue #31). Keeping 'BATCH12' would invent a
    // name that matches nothing and buckets alone in byCounterparty; `null` is
    // skipped by the index and scores 0 in trigramSimilarity.
    assert.equal(normalizeBankDescription('BATCH12'), null);
    assert.equal(normalizeBankDescription('SETL-234567890123-BATCH12'), null);
  });

  test('truncated descriptions degrade rather than throw', () => {
    // DESC_TRUNCATED cuts ~10% of rows mid-token. The parser must yield something
    // usable, and the lost information becomes an anchor_strength problem later,
    // not a crash here.
    assert.equal(normalizeBankDescription('NEFT-SETL-AMZN RET'), 'AMZN RET');
    assert.equal(normalizeBankDescription('NEFT-SE'), 'SE');
  });

  test('blank yields null', () => {
    assert.equal(normalizeBankDescription(''), null);
    assert.equal(normalizeBankDescription(null), null);
  });
});
