/**
 * The single CSV row reader — S1's front door (matching-engine.md §1, S1 PARSE).
 *
 * ===========================================================================
 * THIS FILE OWNS `source_row_number`, AND NOTHING ELSE MAY ASSIGN IT.
 *
 * `source_row_number` is the join key the answer key uses to score every
 * measurement downstream (validation-strategy.md §2.1). An off-by-one here does
 * not throw — it silently attributes every row's verdict to the wrong economic
 * event, and the first place anyone notices is a match rate that is quietly
 * wrong on Day 9.
 *
 * The convention, fixed by schema.md §3 and matched exactly by the generator
 * (`tools/generate/csv.ts` writes `sourceRowNumber = i + 1` for the i-th data
 * row): the header line is row 0, the first data row is row 1, and EVERY
 * physical data line is counted — including ones a parser later rejects or
 * excludes — so the numbering can never shift under downstream filtering.
 *
 * Two `csv-parse` options are load-bearing for that guarantee and are explained
 * inline where they are set. They were both verified against the real fixtures
 * before this was written, not assumed.
 * ===========================================================================
 */

import { parse } from 'csv-parse/sync';

export interface CsvRow {
  /**
   * 1-based physical position in the file; the header is row 0 (schema.md §3).
   * Assigned here, once, from the row's index — never derived later from a
   * filtered collection.
   */
  sourceRowNumber: number;
  /**
   * Field values in file order. Length MAY differ from `header.length` on a
   * malformed row; the caller rejects those rather than this reader dropping
   * them, so `sourceRowNumber` stays contiguous.
   */
  fields: string[];
  /** The exact original bytes of this row (trailing newline stripped), for `RejectedRow.rawLine`. */
  raw: string;
}

export interface CsvDocument {
  header: string[];
  rows: CsvRow[];
}

/** A whole-file parse failure (unterminated quote, etc.) — matching-engine.md §12: run fails `PARSE_FAILED`. */
export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

const stripEol = (s: string): string => s.replace(/\r?\n$/, '');

export function readCsv(text: string): CsvDocument {
  let records: { record: string[]; raw: string }[];
  try {
    records = parse(text, {
      // A blank or ragged line must KEEP its row number and be rejected by the
      // caller — never silently dropped. `skip_empty_lines: true` would shift
      // every subsequent `sourceRowNumber` by one; `relax_column_count: true`
      // keeps a wrong-width row in place (with its real field count) instead of
      // aborting the whole file. Both verified against the fixtures.
      skip_empty_lines: false,
      relax_column_count: true,
      bom: true,
      // Gives us `{ record, raw }` per row so a rejected row can show its
      // original bytes in the UI.
      raw: true,
    }) as { record: string[]; raw: string }[];
  } catch (err) {
    throw new CsvParseError(err instanceof Error ? err.message : String(err));
  }

  if (records.length === 0) return { header: [], rows: [] };

  const [head, ...data] = records;
  return {
    header: head!.record,
    // `data[0]` is the first data row, and it is `sourceRowNumber` 1: the header
    // occupied row 0. This `i + 1` is the entire mapping, and it matches the
    // generator's own emitter line for line.
    rows: data.map((r, i) => ({
      sourceRowNumber: i + 1,
      fields: r.record,
      raw: stripEol(r.raw),
    })),
  };
}
