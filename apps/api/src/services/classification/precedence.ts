/**
 * Exception precedence (schema.md §8.2) — one primary category, the rest as flags.
 *
 * Every record that reaches Tier 3 may satisfy several category definitions at
 * once. The FIRST rule in the declared order becomes `category`; every other rule
 * that also fires is appended to `secondaryFlags`. A record therefore always has
 * exactly one primary category and a complete record of its other properties —
 * neither a made-up single answer nor an unranked pile.
 *
 * The order lives in `EXCEPTION_PRECEDENCE` in types/domain.ts, declared once, so
 * "the order" is the array rather than a switch statement someone can reorder by
 * accident.
 */

import { EXCEPTION_PRECEDENCE, type ExceptionCategory } from '../../types/domain.js';

const RANK = new Map<ExceptionCategory, number>(
  EXCEPTION_PRECEDENCE.map((c, i) => [c, i]),
);

export interface PrecedenceResult {
  primary: ExceptionCategory;
  secondaryFlags: ExceptionCategory[];
}

/**
 * Rank a set of fired categories into one primary plus ordered flags.
 *
 * Duplicates in the input are collapsed. The output flags are in precedence
 * order, not input order, so two runs that discovered the same facts in a
 * different sequence produce byte-identical rows (ADR-032).
 */
export function applyPrecedence(fired: readonly ExceptionCategory[]): PrecedenceResult | null {
  const unique = [...new Set(fired)];
  if (unique.length === 0) return null;

  unique.sort((a, b) => RANK.get(a)! - RANK.get(b)!);
  const [primary, ...secondaryFlags] = unique as [ExceptionCategory, ...ExceptionCategory[]];
  return { primary, secondaryFlags };
}

/** Does `a` outrank `b`? Exported for readable assertions at call sites. */
export function outranks(a: ExceptionCategory, b: ExceptionCategory): boolean {
  return RANK.get(a)! < RANK.get(b)!;
}

/**
 * The presence categories, which are mutually exclusive in practice.
 *
 * "Presence before value" is not really an ordering question: the two classes
 * cannot both apply to the same leg. If no candidate shares an identity anchor it
 * is a presence problem; if a candidate's anchor agrees but its value does not it
 * is a value problem. The precedence order records the intent, and
 * `classify.ts` enforces the exclusivity at the point the signals are built.
 */
export const PRESENCE_CATEGORIES: readonly ExceptionCategory[] = [
  'MISSING_IN_GATEWAY', 'MISSING_IN_BANK', 'MISSING_IN_LEDGER',
];

export function isPresenceCategory(c: ExceptionCategory): boolean {
  return PRESENCE_CATEGORIES.includes(c);
}
