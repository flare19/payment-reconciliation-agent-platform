/**
 * Display names and one-line glosses for the vocabulary the API speaks in.
 *
 * One table, because these strings appear on the dashboard, the exception list,
 * the exception detail and the audit screen, and a category that reads
 * `Missing in Ledger` in one place and `MISSING_IN_LEDGER` in another looks
 * like two different things to someone seeing both for the first time.
 *
 * Every lookup falls back to the raw key. A taxonomy value that reaches the UI
 * without an entry here should be visibly untranslated rather than silently
 * blank — a missing label is a bug worth seeing, and an empty cell is not.
 */

export const CATEGORY_LABEL: Record<string, string> = {
  MISSING_IN_LEDGER: 'Missing in Ledger',
  MISSING_IN_GATEWAY: 'Missing in Gateway',
  MISSING_IN_BANK: 'Missing in Bank',
  AMBIGUOUS_MATCH: 'Ambiguous Match',
  AMOUNT_MISMATCH: 'Amount Mismatch',
  DUPLICATE_RECORD: 'Duplicate Record',
  UNSPLITTABLE_BATCH: 'Unsplittable Batch',
  TIMING_DRIFT: 'Timing Drift',
};

export const CATEGORY_GLOSS: Record<string, string> = {
  MISSING_IN_LEDGER: 'Seen by the gateway or the bank, never booked to the ledger.',
  MISSING_IN_GATEWAY: 'In the bank or the ledger, with no gateway record behind it.',
  MISSING_IN_BANK: 'Captured and booked, but never seen settling in the bank.',
  AMBIGUOUS_MATCH: 'Two or more candidates too close to separate. The engine refused to choose.',
  AMOUNT_MISMATCH: 'Agreeing on identity, disagreeing on amount beyond tolerance.',
  DUPLICATE_RECORD: 'The same source record present more than once.',
  UNSPLITTABLE_BATCH: 'A netted credit the engine could not decompose into its payments.',
  TIMING_DRIFT: 'Matched, but settling outside the expected window for its instrument.',
};

export const RESOLVABILITY_LABEL: Record<string, string> = {
  resolvable_by_human: 'Resolvable by a human',
  needs_external_data: 'Needs external data',
  unresolvable_from_sources: 'Unresolvable from these sources',
};

/**
 * The question a reviewer asks before opening anything: is this worth my time?
 * It is a rule output derived from the evidence, never an LLM judgement.
 */
export const RESOLVABILITY_GLOSS: Record<string, string> = {
  resolvable_by_human:
    'Candidates were found. Someone with context can decide what the engine would not.',
  needs_external_data:
    'Answerable, but not from these three files — it needs something nobody uploaded.',
  unresolvable_from_sources:
    'No anchor and no candidate. Reconciling this from these sources is not possible, by construction.',
};

export const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  explained: 'Explained',
  human_resolved: 'Resolved',
  wont_fix: 'Won’t Fix',
  pending_review: 'Pending Review',
  auto_confirmed: 'Auto-confirmed',
  human_confirmed: 'Human-confirmed',
  rejected: 'Rejected',
};

export const TIER_LABEL: Record<string, string> = {
  exact: 'Exact',
  alias: 'Alias-resolved',
  fuzzy: 'Fuzzy',
  batch: 'Batch-decomposed',
  manual: 'Manual',
  implied: 'Implied',
};

/**
 * Where an explanation's words came from. Labelling this is not a technical
 * detail — it is the visible proof that the system works without the LLM
 * (ui-spec §4), and it is the difference between "the model wrote this" and
 * "a template did, because the model was unavailable and nothing broke".
 */
/**
 * ONE AXIS: WHO WROTE THE WORDS. Reuse is a qualifier on that, not an
 * alternative to it.
 *
 * `llm_cache` read *From the signature cache*, in the same slot and the same
 * grammar as *Written by the model*, so the two read as different authors. They
 * are not — a cached explanation was written by the model too, for the first
 * exception of its shape, and this run reused it rather than paying to write
 * the same paragraph 212 times. The foot of that same block has always said
 * "The model wrote these words", so the screen contradicted itself: tag said
 * cache, footnote said model (ADR-138).
 *
 * The reuse still has to show — it is the cost story, and a reader deserves to
 * know the model was not called for this row. It shows as what it is: a second
 * clause on the same sentence.
 *
 * "THE MODEL" IS RETIRED FROM THIS TAG, AND IT TOOK THREE REPORTS TO LEARN WHY
 * (ADR-143). Naming the surface — "Explanation written by the model" — was
 * tried first (ADR-140) and still read as a claim about the Analyst on an
 * exception nobody had investigated, three separate times, by the person who
 * built the page. "The model" is a common noun; a reader with a named system
 * called the Analyst already in view will resolve it to that name, no matter
 * how the sentence around it is qualified. Adding words to a noun that is
 * already wrong does not fix it.
 *
 * "Explain Layer" is not a new term — it already labels its own panel further
 * down this exact page (`EnginePerformance`, "Cost of Running It" → "Explain
 * Layer"), so this tag and that panel now name the same thing the same way,
 * and neither spells anything close to "Analyst". Two proper nouns cannot be
 * confused for each other the way two readings of "the model" can.
 */
export const EXPLANATION_SOURCE_LABEL: Record<string, string> = {
  llm: 'Written by the Explain Layer',
  llm_cache: 'Written by the Explain Layer, reused',
  template: 'Written by a template',
};

export const ACTOR_LABEL: Record<string, string> = {
  engine: 'Engine',
  human: 'Human',
  llm: 'Model',
  agent: 'Analyst',
};

export const VERDICT_LABEL: Record<string, string> = {
  RESOLUTION_PROPOSED: 'Resolution Proposed',
  CONFIRMED_UNRESOLVABLE: 'Confirmed Unresolvable',
  NEEDS_EXTERNAL_DATA: 'Needs External Data',
  INSUFFICIENT_EVIDENCE: 'Insufficient Evidence',
};

export const SOURCE_LABEL: Record<string, string> = {
  gateway: 'Gateway',
  bank: 'Bank',
  ledger: 'Ledger',
};

export const label = (table: Record<string, string>, key: string | null | undefined) =>
  (key ? table[key] ?? key : '—');
