/**
 * ALL SQL for `explanation_cache` lives here and nowhere else (CLAUDE.md §4.1).
 *
 * The cache key is a DISCREPANCY SIGNATURE (ADR-018): the structural shape of a
 * problem with its specifics stripped, so a hundred settlement-lag exceptions
 * share one model call. This file never computes a signature — `services/explain`
 * does — because a hash computed in two places is two cache namespaces that look
 * like one.
 *
 * ── Why `model` and `prompt_version` are part of the KEY, not just recorded ──
 * They are hashed into `signature_hash` upstream. If they were merely columns, a
 * run on a new model would serve prose written by a model it no longer uses, and
 * the explanation shown to a judge would not be the explanation the configured
 * system produces. The columns here exist so a reader can SEE which model wrote
 * a cached row without recomputing the hash.
 *
 * snake_case in, camelCase out. This layer is the mapping boundary.
 */

import { getPool, type TxClient } from '../db/pool.js';
import type { ExceptionCategory } from '../types/domain.js';

export interface CachedExplanation {
  signatureHash: string;
  promptVersion: string;
  model: string;
  category: ExceptionCategory;
  signatureInput: Record<string, unknown>;
  explanationText: string;
  suggestedAction: string;
  tokensIn: number | null;
  tokensOut: number | null;
  hitCount: number;
  createdAt: Date;
}

const COLUMNS = `
  signature_hash, prompt_version, model, category, signature_input,
  explanation_text, suggested_action, tokens_in, tokens_out, hit_count, created_at`;

interface CacheRow {
  signature_hash: string;
  prompt_version: string;
  model: string;
  category: ExceptionCategory;
  signature_input: Record<string, unknown>;
  explanation_text: string;
  suggested_action: string;
  tokens_in: number | null;
  tokens_out: number | null;
  hit_count: number;
  created_at: Date;
}

function toCached(r: CacheRow): CachedExplanation {
  return {
    signatureHash: r.signature_hash,
    promptVersion: r.prompt_version,
    model: r.model,
    category: r.category,
    signatureInput: r.signature_input,
    explanationText: r.explanation_text,
    suggestedAction: r.suggested_action,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    hitCount: r.hit_count,
    createdAt: r.created_at,
  };
}

/**
 * Look up and count the hit in one statement.
 *
 * A read followed by a separate counter UPDATE is two round trips on the hottest
 * path in S13, and the counter is what the cost story is told from — the cache
 * hit rate is a number the submission reports, so losing increments to a crash
 * between the two statements would understate the thing being demonstrated.
 */
export async function getCachedExplanation(
  signatureHash: string, client?: TxClient,
): Promise<CachedExplanation | null> {
  const { rows } = await (client ?? getPool()).query<CacheRow>(
    `UPDATE explanation_cache SET hit_count = hit_count + 1
      WHERE signature_hash = $1
      RETURNING ${COLUMNS}`,
    [signatureHash],
  );
  return rows.length === 0 ? null : toCached(rows[0]!);
}

/** Read without counting a hit — for the UI's cache inspector, not the explain path. */
export async function peekCachedExplanation(
  signatureHash: string,
): Promise<CachedExplanation | null> {
  const { rows } = await getPool().query<CacheRow>(
    `SELECT ${COLUMNS} FROM explanation_cache WHERE signature_hash = $1`, [signatureHash]);
  return rows.length === 0 ? null : toCached(rows[0]!);
}

export interface PutExplanationInput {
  signatureHash: string;
  promptVersion: string;
  model: string;
  category: ExceptionCategory;
  signatureInput: Record<string, unknown>;
  explanationText: string;
  suggestedAction: string;
  /** NULL for template-sourced rows — no model was called, so no tokens were spent. */
  tokensIn?: number | null;
  tokensOut?: number | null;
}

/**
 * Store a freshly generated explanation.
 *
 * `ON CONFLICT DO NOTHING`, not `DO UPDATE`: two concurrent exceptions with the
 * same signature can both miss the cache and both call the model, and the second
 * writer must not overwrite the first. The rows are equivalent by construction —
 * that is what a signature MEANS — so the first one wins and the second is
 * discarded rather than racing.
 */
export async function putExplanation(
  input: PutExplanationInput, client?: TxClient,
): Promise<void> {
  await (client ?? getPool()).query(
    `INSERT INTO explanation_cache (
       signature_hash, prompt_version, model, category, signature_input,
       explanation_text, suggested_action, tokens_in, tokens_out)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (signature_hash) DO NOTHING`,
    [
      input.signatureHash, input.promptVersion, input.model, input.category,
      JSON.stringify(input.signatureInput), input.explanationText, input.suggestedAction,
      input.tokensIn ?? null, input.tokensOut ?? null,
    ],
  );
}

/**
 * Cache effectiveness, for `runs.metrics` and the cost story.
 *
 * `hit_count` counts lookups that FOUND a row; `entries` counts distinct
 * signatures. Calls avoided is the difference — the honest way to state the
 * saving, rather than quoting a ratio whose denominator nobody can see.
 */
export async function explanationCacheStats(): Promise<{
  entries: number; totalHits: number; tokensIn: number; tokensOut: number;
}> {
  const { rows } = await getPool().query<{
    entries: number; total_hits: number; tokens_in: number; tokens_out: number;
  }>(
    `SELECT count(*)::int              AS entries,
            COALESCE(sum(hit_count),0)::int  AS total_hits,
            COALESCE(sum(tokens_in),0)::int  AS tokens_in,
            COALESCE(sum(tokens_out),0)::int AS tokens_out
       FROM explanation_cache`,
  );
  const r = rows[0]!;
  return {
    entries: r.entries, totalHits: r.total_hits,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out,
  };
}
