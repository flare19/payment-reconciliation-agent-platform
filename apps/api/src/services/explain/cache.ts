/**
 * S13 — the explain driver (schema.md §10.3).
 *
 * Named `cache.ts` because cache resolution is the whole economy of the stage:
 * ADR-018's collapse turns ~75 exceptions into 15–30 signatures into ≤8
 * requests, and everything else here is bookkeeping around that.
 *
 * The pipeline, exactly §10.3's five steps:
 *   1. group the run's exceptions by `signature_hash`
 *   2. drop signatures already cached at this `prompt_version` (counting a hit)
 *   3. batch the rest, ≤10 signatures per request
 *   4. fan each answer out to every exception sharing that signature
 *   5. stop at `LLM_MAX_CALLS_PER_RUN`; everything past it takes the template
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * NO DATABASE TRANSACTION IS HELD ACROSS A NETWORK CALL.
 *
 * This module does the reading and the model calls; the ORCHESTRATOR does the
 * writing, afterwards, in one transaction. That split is not stylistic. Holding
 * a transaction open across up to eight 20-second HTTP round trips would keep
 * the audit chain's advisory lock for the duration, block every other append,
 * and sit exposed to a managed-Postgres idle-in-transaction timeout — on
 * Railway, the platform this deploys to. The stage is slow because it talks to
 * a model; the write must not inherit that.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── TEMPLATE ROWS ARE NEVER WRITTEN TO `explanation_cache` (ADR-084) ──
 * A template is free, deterministic, and recomputable from the category alone,
 * so caching one buys nothing. What it would COST is severe and silent: the
 * cache is keyed by signature, so a template row written during a keyless run
 * would be served as a hit by every later run — including runs that DO have a
 * key — and that signature would never be sent to the model again. One offline
 * afternoon would permanently downgrade the demo, with nothing in the output
 * saying so. `explanation_cache.tokens_in`'s "NULL for template-sourced rows"
 * comment describes a column's nullability; it does not require this.
 *
 * ── THE LLM STILL DECIDES NOTHING (ADR-017) ──
 * Every exception's category, severity and evidence are read from rows S12
 * already committed, and are passed through untouched. The only fields this
 * stage writes are `explanation_text`, `suggested_action`, `explanation_source`
 * and `signature_hash`.
 */

import type { ExceptionCategory, Severity } from '../../types/domain.js';
import type { ExplanationSource } from '../../repositories/exceptions.js';
import {
  computeSignature, type ExceptionForSignature, type SignatureComponents,
  type TxForSignature,
} from './signature.js';
import {
  MAX_SIGNATURES_PER_REQUEST, type ExplainLlmClient, type SignaturePrompt,
} from './llm-client.js';
import { templateFor } from './templates.js';

/** What the driver needs from a persisted exception row. */
export interface ExceptionToExplain extends ExceptionForSignature {
  id: string;
  severity: Severity;
}

/** One distinct discrepancy shape, and every exception wearing it. */
export interface SignatureGroup {
  hash: string;
  components: SignatureComponents;
  category: ExceptionCategory;
  /** Exception ids, in the order `planSignatures` received them. */
  exceptionIds: string[];
  /** `exceptionIds.length` — §10.4's `occurrence_count`. */
  occurrenceCount: number;
  /** The most severe exception in the group; drives budget ordering. */
  topSeverity: Severity;
}

/** Why a group ended up with the text it has — the audit `reason`. */
export type TemplateCause =
  | 'no_client' | 'call_cap' | 'malformed_response' | 'transport_failure' | 'not_in_response';

export interface ResolvedSignature {
  hash: string;
  components: SignatureComponents;
  category: ExceptionCategory;
  source: ExplanationSource;
  explanationText: string;
  suggestedAction: string;
  tokensIn: number | null;
  tokensOut: number | null;
  exceptionIds: string[];
  occurrenceCount: number;
  /** Only fresh model output is persisted to the cache — see ADR-084 above. */
  needsCacheWrite: boolean;
  /** Set only when `source === 'template'`. */
  templateCause: TemplateCause | null;
  /** Human-readable, for the audit entry. Never a placeholder. */
  reason: string;
}

export interface ExplainStats {
  signaturesTotal: number;
  cacheHits: number;
  generated: number;
  templated: number;
  /** Actual HTTP requests, retries included. Bounded by `llmMaxCallsPerRun`. */
  apiCalls: number;
  exceptionsExplained: number;
  tokensIn: number;
  tokensOut: number;
  /**
   * True when at least one signature took a template because the run's call
   * budget was spent. Reported so a reader can tell "the cap bound" from "the
   * model was never configured" — both produce templates, and only one of them
   * is a tuning question.
   */
  callCapReached: boolean;
  /** Present only when a batch failed; one entry per failed batch. */
  failures: { reason: 'malformed' | 'transport'; detail: string }[];
}

export interface ExplainOutcome {
  resolved: ResolvedSignature[];
  stats: ExplainStats;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Enough hash to identify a signature in a log line; the full value is in `details`. */
function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

/**
 * Step 1 — group by signature.
 *
 * PURE. The ordering is total and deterministic (ADR-032): most severe first,
 * then most widely shared, then by hash. That order is what the LLM budget is
 * spent along, so an unspecified one would mean two runs of the same data
 * explaining different exceptions with the model — the same class of
 * irreproducibility ADR-032 exists to prevent, arriving through a stage that
 * does not affect matching.
 *
 * Severity first because the budget should buy prose for what a controller
 * reads first; occurrence second because a signature covering 40 exceptions is
 * worth more per request than one covering 1.
 */
export function planSignatures(
  exceptions: readonly ExceptionToExplain[],
  txById: ReadonlyMap<string, TxForSignature>,
  opts: { promptVersion: string; model: string },
): SignatureGroup[] {
  const groups = new Map<string, SignatureGroup>();

  for (const e of exceptions) {
    const { hash, components } = computeSignature(e, txById, opts);
    const existing = groups.get(hash);
    if (existing === undefined) {
      groups.set(hash, {
        hash,
        components,
        category: e.category,
        exceptionIds: [e.id],
        occurrenceCount: 1,
        topSeverity: e.severity,
      });
      continue;
    }
    existing.exceptionIds.push(e.id);
    existing.occurrenceCount += 1;
    if (SEVERITY_RANK[e.severity] < SEVERITY_RANK[existing.topSeverity]) {
      existing.topSeverity = e.severity;
    }
  }

  return [...groups.values()].sort((a, b) =>
    SEVERITY_RANK[a.topSeverity] - SEVERITY_RANK[b.topSeverity]
    || b.occurrenceCount - a.occurrenceCount
    || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
}

function toPrompt(group: SignatureGroup, id: string): SignaturePrompt {
  const c = group.components;
  return {
    id,
    category: group.category,
    amountDelta: c.amountDeltaBucket,
    dateDelta: c.dateDeltaBucket,
    sourcesPresent: c.sourcesPresent,
    anchorStrength: c.anchorStrength,
    aliasInvolved: c.aliasInvolved,
    candidateCount: c.candidateCountBucket,
    secondaryFlags: c.secondaryFlagsSorted === '' ? [] : c.secondaryFlagsSorted.split(','),
    occurrenceCount: group.occurrenceCount,
  };
}

const TEMPLATE_REASON: Record<TemplateCause, string> = {
  no_client: 'no LLM client is configured, so the hand-written template was used',
  call_cap: 'the run\'s LLM call budget was already spent, so the hand-written template was used',
  malformed_response: 'the model returned unusable JSON twice, so the hand-written template was used',
  transport_failure: 'the model could not be reached, so the hand-written template was used',
  not_in_response: 'the model\'s response did not cover this signature, so the hand-written template was used',
};

function asTemplate(group: SignatureGroup, cause: TemplateCause): ResolvedSignature {
  const t = templateFor(group.category);
  return {
    hash: group.hash,
    components: group.components,
    category: group.category,
    source: 'template',
    explanationText: t.explanationText,
    suggestedAction: t.suggestedAction,
    // No model was called, so there are no tokens. NULL, never 0 — the same rule
    // `run-metrics.ts` applies to an unrun stage.
    tokensIn: null,
    tokensOut: null,
    exceptionIds: group.exceptionIds,
    occurrenceCount: group.occurrenceCount,
    needsCacheWrite: false,
    templateCause: cause,
    reason:
      `template explanation for ${group.category} signature ${shortHash(group.hash)} `
      + `covering ${group.occurrenceCount} exception(s): ${TEMPLATE_REASON[cause]}`,
  };
}

export interface ExplainDeps {
  /** `null` when there is no key or the layer is switched off — a legitimate state. */
  client: ExplainLlmClient | null;
  /**
   * Cache read that COUNTS the hit. `getCachedExplanation` in
   * `repositories/explanations.ts`; injected so this module stays testable
   * without a database and so all SQL stays in the repository layer.
   */
  lookupCache(signatureHash: string): Promise<{
    explanationText: string; suggestedAction: string;
    tokensIn: number | null; tokensOut: number | null;
  } | null>;
}

/**
 * Steps 2–5. Reads the cache, calls the model, and returns what should be
 * written — writing nothing itself.
 */
export async function resolveExplanations(
  groups: readonly SignatureGroup[],
  deps: ExplainDeps,
  opts: { llmMaxCallsPerRun: number },
): Promise<ExplainOutcome> {
  const resolved: ResolvedSignature[] = [];
  const misses: SignatureGroup[] = [];
  const failures: ExplainStats['failures'] = [];
  let cacheHits = 0;

  // ── Step 2: the cache, in the planned order ──
  for (const group of groups) {
    const hit = await deps.lookupCache(group.hash);
    if (hit === null) { misses.push(group); continue; }
    cacheHits += 1;
    resolved.push({
      hash: group.hash,
      components: group.components,
      category: group.category,
      source: 'llm_cache',
      explanationText: hit.explanationText,
      suggestedAction: hit.suggestedAction,
      // The cached row's token counts belong to the run that PAID them. Carrying
      // them forward here would re-bill this run for tokens it did not spend and
      // make the cache look like it saved nothing.
      tokensIn: null,
      tokensOut: null,
      exceptionIds: group.exceptionIds,
      occurrenceCount: group.occurrenceCount,
      needsCacheWrite: false,
      templateCause: null,
      reason:
        `cached explanation reused for ${group.category} signature `
        + `${shortHash(group.hash)}, covering ${group.occurrenceCount} exception(s)`,
    });
  }

  // ── Steps 3–5: batches, against a budget measured in REAL requests ──
  let budget = Math.max(0, opts.llmMaxCallsPerRun);
  let apiCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let generated = 0;

  for (let start = 0; start < misses.length; start += MAX_SIGNATURES_PER_REQUEST) {
    const chunk = misses.slice(start, start + MAX_SIGNATURES_PER_REQUEST);

    if (deps.client === null) {
      for (const g of chunk) resolved.push(asTemplate(g, 'no_client'));
      continue;
    }
    if (budget <= 0) {
      for (const g of chunk) resolved.push(asTemplate(g, 'call_cap'));
      continue;
    }

    // Batch-local ids. The model has no use for a 64-char hash, and a short id
    // keeps the prompt small and the response easy to validate against what was
    // actually asked (`parseResponse` drops anything else).
    const idOf = new Map<string, SignatureGroup>();
    const prompts = chunk.map((g, i) => {
      const id = `sig_${i + 1}`;
      idOf.set(id, g);
      return toPrompt(g, id);
    });

    const result = await deps.client.explainBatch(prompts, { maxRequests: budget });
    apiCalls += result.requestsMade;
    budget -= result.requestsMade;

    if (!result.ok) {
      failures.push({ reason: result.reason, detail: result.detail });
      const cause: TemplateCause =
        result.reason === 'malformed' ? 'malformed_response' : 'transport_failure';
      for (const g of chunk) resolved.push(asTemplate(g, cause));
      continue;
    }

    tokensIn += result.tokensIn ?? 0;
    tokensOut += result.tokensOut ?? 0;

    // Per-request token counts cover the whole batch, so attributing them to any
    // one signature would be a made-up split. They are summed into the run's
    // stats and stored as NULL on each cache row (§10.2 allows NULL) rather than
    // divided by a number nobody can check.
    for (const [id, group] of idOf) {
      const text = result.byId.get(id);
      if (text === undefined) { resolved.push(asTemplate(group, 'not_in_response')); continue; }
      generated += 1;
      resolved.push({
        hash: group.hash,
        components: group.components,
        category: group.category,
        source: 'llm',
        explanationText: text.explanation,
        suggestedAction: text.suggestedAction,
        tokensIn: null,
        tokensOut: null,
        exceptionIds: group.exceptionIds,
        occurrenceCount: group.occurrenceCount,
        needsCacheWrite: true,
        templateCause: null,
        reason:
          `explanation generated by ${deps.client.model} for ${group.category} signature `
          + `${shortHash(group.hash)}, covering ${group.occurrenceCount} exception(s)`,
      });
    }
  }

  const templated = resolved.filter((r) => r.source === 'template').length;
  return {
    resolved,
    stats: {
      signaturesTotal: groups.length,
      cacheHits,
      generated,
      templated,
      apiCalls,
      exceptionsExplained: resolved.reduce((n, r) => n + r.exceptionIds.length, 0),
      tokensIn,
      tokensOut,
      callCapReached: resolved.some((r) => r.templateCause === 'call_cap'),
      failures,
    },
  };
}

/** §9.1's three explain events, chosen by where the text came from. */
export function auditEventFor(source: ExplanationSource): string {
  if (source === 'llm') return 'EXPLANATION_GENERATED';
  if (source === 'llm_cache') return 'EXPLANATION_CACHE_HIT';
  return 'EXPLANATION_FALLBACK_TEMPLATE';
}
