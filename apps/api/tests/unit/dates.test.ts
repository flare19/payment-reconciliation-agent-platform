import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSourceDate, dayDelta, addDays, withinWindow, businessDateFromInstant, DateWarning,
} from '../../src/services/ingestion/dates.js';

function parsed(raw: string, format: Parameters<typeof parseSourceDate>[1]) {
  const r = parseSourceDate(raw, format);
  assert.ok(r.ok, `expected "${raw}" to parse as ${format}`);
  assert.ok(r.value !== null, `expected a value for "${raw}"`);
  return r.value;
}

describe('parseSourceDate', () => {
  test('THE AMBIGUOUS CASE: 03/04/2026 depends entirely on the declared format', () => {
    // The single most consequential line in this file. Nothing in the string says
    // which reading is right; the generator emits days >= 13 on only ~30% of rows
    // precisely so inference cannot cheat (schema.md §2.3).
    assert.equal(parsed('03/04/2026', 'MM/DD/YYYY').businessDate, '2026-03-04'); // 4 March
    assert.equal(parsed('03-04-2026', 'DD-MM-YYYY').businessDate, '2026-04-03'); // 3 April
  });

  test('each source format, parsed as declared', () => {
    assert.equal(parsed('2026-08-14 08:15:02', 'YYYY-MM-DD HH:MM:SS').businessDate, '2026-08-14');
    assert.equal(parsed('14-08-2026', 'DD-MM-YYYY').businessDate, '2026-08-14');
    assert.equal(parsed('08/14/2026', 'MM/DD/YYYY').businessDate, '2026-08-14');
  });

  test('a value in the wrong format is rejected, never coerced', () => {
    assert.equal(parseSourceDate('14/08/2026', 'MM/DD/YYYY').ok, false); // month 14
    assert.equal(parseSourceDate('2026-08-14', 'DD-MM-YYYY').ok, false);
    assert.equal(parseSourceDate('2026-02-30 00:00:00', 'YYYY-MM-DD HH:MM:SS').ok, false);
    assert.equal(parseSourceDate('2026-13-01 00:00:00', 'YYYY-MM-DD HH:MM:SS').ok, false);
    assert.equal(parseSourceDate('2026-08-14 25:00:00', 'YYYY-MM-DD HH:MM:SS').ok, false);
  });

  test('IST wall time converts to the correct UTC instant', () => {
    // 08:15:02 IST = 02:45:02 UTC (UTC+05:30, no DST in India, ever).
    const v = parsed('2026-08-14 08:15:02', 'YYYY-MM-DD HH:MM:SS');
    assert.equal(v.timestampUtc, '2026-08-14T02:45:02.000Z');
    assert.ok(v.warnings.includes(DateWarning.ASSUMED_IST));
  });

  test('TZ_MIDNIGHT_DRIFT, asserted in both directions', () => {
    // 00:20 IST on the 15th is 18:50 UTC on the 14th. The BUSINESS DATE stays the
    // 15th — that is why both are stored — and the crossing is flagged so a
    // one-day gap later reads as a known artifact rather than a mystery.
    const justAfter = parsed('2026-08-15 00:20:00', 'YYYY-MM-DD HH:MM:SS');
    assert.equal(justAfter.businessDate, '2026-08-15');
    assert.equal(justAfter.timestampUtc, '2026-08-14T18:50:00.000Z');
    assert.ok(justAfter.warnings.includes(DateWarning.CROSSED_MIDNIGHT_UTC));

    // Just before IST midnight: same IST day, same UTC day, no flag.
    const justBefore = parsed('2026-08-14 23:40:00', 'YYYY-MM-DD HH:MM:SS');
    assert.equal(justBefore.businessDate, '2026-08-14');
    assert.equal(justBefore.timestampUtc, '2026-08-14T18:10:00.000Z');
    assert.ok(!justBefore.warnings.includes(DateWarning.CROSSED_MIDNIGHT_UTC));

    // The boundary itself: 05:30 IST is exactly 00:00 UTC the same day.
    assert.equal(parsed('2026-08-14 05:30:00', 'YYYY-MM-DD HH:MM:SS').timestampUtc,
      '2026-08-14T00:00:00.000Z');
    // One minute earlier is the previous UTC day.
    assert.equal(parsed('2026-08-14 05:29:00', 'YYYY-MM-DD HH:MM:SS').timestampUtc,
      '2026-08-13T23:59:00.000Z');
  });

  test('date-granularity sources get no fabricated timestamp', () => {
    // Inventing a midnight instant would assert precision the source never had.
    assert.equal(parsed('14-08-2026', 'DD-MM-YYYY').timestampUtc, null);
    assert.equal(parsed('08/14/2026', 'MM/DD/YYYY').timestampUtc, null);
  });

  test('blank is missing, not an error', () => {
    for (const blank of ['', '   ', null, undefined]) {
      const r = parseSourceDate(blank, 'DD-MM-YYYY');
      assert.ok(r.ok && r.value === null && r.warnings.includes(DateWarning.MISSING));
    }
  });

  test('businessDateFromInstant inverts the conversion', () => {
    assert.equal(businessDateFromInstant(new Date('2026-08-14T18:50:00.000Z')), '2026-08-15');
    assert.equal(businessDateFromInstant(new Date('2026-08-14T18:10:00.000Z')), '2026-08-14');
  });
});

describe('calendar arithmetic', () => {
  test('dayDelta is signed and crosses month and year boundaries', () => {
    assert.equal(dayDelta('2026-08-14', '2026-08-16'), 2);
    assert.equal(dayDelta('2026-08-16', '2026-08-14'), -2);
    assert.equal(dayDelta('2026-08-14', '2026-08-14'), 0);
    assert.equal(dayDelta('2026-08-31', '2026-09-01'), 1);
    assert.equal(dayDelta('2026-12-31', '2027-01-01'), 1);
    assert.equal(dayDelta('2028-02-28', '2028-03-01'), 2); // 2028 is a leap year
    assert.equal(dayDelta('2026-02-28', '2026-03-01'), 1); // 2026 is not
  });

  test('addDays stays in calendar space', () => {
    assert.equal(addDays('2026-08-14', 3), '2026-08-17');
    assert.equal(addDays('2026-08-31', 1), '2026-09-01');
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  });

  test('withinWindow is INCLUSIVE at both edges', () => {
    // Exact edges, not "around" (testing-strategy §1.2). Off-by-one at a boundary
    // is the classic accuracy bug and it never crashes.
    const cardWindow = [-1, 3] as const;
    assert.equal(withinWindow('2026-08-14', '2026-08-13', cardWindow), true);  // -1 edge
    assert.equal(withinWindow('2026-08-14', '2026-08-12', cardWindow), false); // -2 outside
    assert.equal(withinWindow('2026-08-14', '2026-08-17', cardWindow), true);  // +3 edge
    assert.equal(withinWindow('2026-08-14', '2026-08-18', cardWindow), false); // +4 outside
    assert.equal(withinWindow('2026-08-14', '2026-08-14', cardWindow), true);  // same day
  });

  test('no local-timezone influence in the comparison path', () => {
    // These are pure string/UTC calculations. If any Date-from-string parsing
    // crept in, a machine east or west of UTC would disagree here.
    const original = process.env['TZ'];
    try {
      for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
        process.env['TZ'] = tz;
        assert.equal(dayDelta('2026-08-14', '2026-08-16'), 2, `dayDelta drifted under TZ=${tz}`);
        assert.equal(addDays('2026-08-31', 1), '2026-09-01', `addDays drifted under TZ=${tz}`);
        assert.equal(
          parsed('2026-08-15 00:20:00', 'YYYY-MM-DD HH:MM:SS').timestampUtc,
          '2026-08-14T18:50:00.000Z', `parse drifted under TZ=${tz}`);
      }
    } finally {
      if (original === undefined) delete process.env['TZ']; else process.env['TZ'] = original;
    }
  });
});
