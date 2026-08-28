/**
 * Shared plumbing for the three source parsers (schema.md §2–§3).
 *
 * Each parser walks its file row by row and, per row, produces EITHER a
 * `NormalizedTransaction` OR a `RejectedRow` (ADR-046) — never both, never
 * neither. This module holds the pieces all three share: field access that is
 * safe on a short row, the money/date wrappers that decide "warning vs
 * rejection", and warning de-duplication.
 */

import type { RejectedRow } from '../../types/engine.js';
import type { SourceSystem } from '../../types/domain.js';
import type { CsvRow } from './csv.js';
import { parseMoney } from './money.js';
import { parseSourceDate, type SourceDateFormat, type ParsedDate } from './dates.js';

export const isBlank = (v: string | null | undefined): boolean =>
  v === null || v === undefined || v.trim() === '';

/** Header-indexed field access. Returns `''` for a column the row does not reach. */
export function fieldReader(header: string[], row: CsvRow): (column: string) => string {
  const index = new Map(header.map((name, i) => [name, i]));
  return (column) => {
    const i = index.get(column);
    if (i === undefined) return '';
    return row.fields[i] ?? '';
  };
}

/** The complete original row as `{ column: value }`, for `transactions.raw_payload`. */
export function rawPayloadOf(header: string[], row: CsvRow): Record<string, string> {
  const out: Record<string, string> = {};
  header.forEach((name, i) => {
    out[name] = row.fields[i] ?? '';
  });
  return out;
}

export function rejectedRow(source: SourceSystem, row: CsvRow, error: string): RejectedRow {
  return { sourceSystem: source, rowNumber: row.sourceRowNumber, rawLine: row.raw, error };
}

/**
 * A row-scoped accumulator. Collects ingest warnings (de-duplicated, insertion
 * order preserved) and lets a parser bail to a `RejectedRow` from anywhere in
 * its body via a thrown sentinel that the parser's own `try` turns back into a
 * value — keeps the happy path readable instead of threading `| RejectedRow`
 * through every field.
 */
export class RowReject {
  constructor(readonly error: string) {}
}

export class RowContext {
  private readonly seen = new Set<string>();
  readonly warnings: string[] = [];

  warn(...codes: string[]): void {
    for (const code of codes) {
      if (!this.seen.has(code)) {
        this.seen.add(code);
        this.warnings.push(code);
      }
    }
  }

  /** Reject the row now. Always `throw ctx.reject(...)`. */
  reject(error: string): RowReject {
    return new RowReject(error);
  }

  /**
   * A money field that MUST hold a value. Blank or unparseable → the row is
   * rejected (money.ts's own doc: non-numeric content rejects the row, it is
   * never defaulted to 0).
   */
  requireMoney(column: string, raw: string): number {
    const r = parseMoney(raw);
    if (!r.ok) throw this.reject(`${column}: ${r.error}`);
    if (r.paise === null) throw this.reject(`${column} is required but blank`);
    this.warn(...r.warnings);
    return r.paise;
  }

  /**
   * A money field that may legitimately be blank (fee/tax/net on ~15% of
   * gateway rows — schema.md §2.1). Blank → `null`. Present-but-garbage still
   * rejects the row: a fee column containing `"n/a"` is a defect, not a zero.
   */
  optionalMoney(column: string, raw: string): number | null {
    const r = parseMoney(raw);
    if (!r.ok) throw this.reject(`${column}: ${r.error}`);
    // A legitimately-blank optional field is expected, not noteworthy — don't
    // record a MISSING warning for it. Warnings about a value that IS present
    // (a currency symbol, sub-paise rounding) still matter.
    if (r.paise !== null) this.warn(...r.warnings);
    return r.paise;
  }

  /** A date field that MUST parse. Blank or malformed → rejected. */
  requireDate(column: string, raw: string, format: SourceDateFormat): ParsedDate {
    const r = parseSourceDate(raw, format);
    if (!r.ok) throw this.reject(`${column}: ${r.error}`);
    if (r.value === null) throw this.reject(`${column} is required but blank`);
    this.warn(...r.warnings);
    return r.value;
  }

  /** A date field that may be blank (gateway `captured_at`, bank `posting_date`). */
  optionalDate(column: string, raw: string, format: SourceDateFormat): ParsedDate | null {
    const r = parseSourceDate(raw, format);
    if (!r.ok) throw this.reject(`${column}: ${r.error}`);
    if (r.value !== null) this.warn(...r.warnings);
    return r.value;
  }
}
