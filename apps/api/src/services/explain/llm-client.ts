/**
 * S13 — the Gemini explain client (schema.md §10.3/§10.4, ADR-080).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THIS MODULE NEVER DECIDES ANYTHING (ADR-017).
 *
 * It is handed a list of signatures whose category and severity are already
 * final and committed, and it returns prose. The return type carries exactly two
 * strings per signature — `explanation` and `suggestedAction` — so there is no
 * channel through which a model response could reach a match, a category or a
 * score. That is enforced by the type, not by discipline.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── IT NEVER THROWS ──
 * Every outcome is a value: `{ ok: true, ... }` or `{ ok: false, reason, ... }`.
 * A failure here is an ORDINARY path, not an exception — the run must complete
 * with no API key at all, with a dead network, or with a model returning
 * nonsense, and in every one of those cases the driver writes template
 * explanations and the run finishes (ADR-017). Throwing would make the explain
 * layer capable of failing a run, which is precisely what §10.1 forbids.
 *
 * `requestsMade` comes back on BOTH arms, and that matters: a retry is a real
 * request against a real quota, so the driver debits its budget by what was
 * actually spent rather than by the number of batches it intended to send.
 * Without that, `LLM_MAX_CALLS_PER_RUN: 8` would permit 16 requests on a bad day
 * — double the cap it advertises. On a free-tier key the binding resource is
 * requests per day (ADR-080 consequence 2), so this is the number that matters.
 *
 * ── SPELLING: THE DOC IS PROVIDER-NEUTRAL, THE SDK IS NOT ──
 * schema.md §10.3 and ADR-080 write the structured-output config abstractly as
 * `response_format: { type: 'text', mime_type: 'application/json', schema }`.
 * `@google/genai` spells the same two things `responseMimeType` and
 * `responseSchema` inside `config`. This is a spelling difference, not a design
 * difference: same JSON mime type, same schema, same `temperature: 0`.
 *
 * ── NO PROMPT CACHING IS ASSUMED (ADR-080 consequence 4) ──
 * The static system prompt is sent once per batch and is not assumed to be
 * discounted. The economy is ADR-018's signature collapse — ~75 exceptions to
 * 15–30 signatures to ≤8 requests — which is a property of the batching and
 * holds on any provider.
 */

import { GoogleGenAI, Type } from '@google/genai';

import type { AnchorStrength, ExceptionCategory } from '../../types/domain.js';
import { SYSTEM_PROMPT } from './templates.js';

/** §10.3: up to 10 signatures per request. Larger batches raise the cost of a retry. */
export const MAX_SIGNATURES_PER_REQUEST = 10;

/**
 * Per-request wall clock.
 *
 * Not a decision input (ADR-039 governs the DECISION path; this reaches only
 * whether prose or a template is written), but it is a demo-safety bound: a
 * hung connection must not stall a run in front of a panel. Eight batches at
 * this ceiling is the worst case, and the template fallback makes an abort
 * cheap rather than fatal.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/** One signature as the model sees it — buckets and counts, never a specific. */
export interface SignaturePrompt {
  /** Batch-local id (`sig_1`…). NOT the hash: the model has no use for 64 hex chars. */
  id: string;
  category: ExceptionCategory;
  amountDelta: string;
  dateDelta: string;
  sourcesPresent: string;
  anchorStrength: AnchorStrength;
  aliasInvolved: 'yes' | 'no';
  candidateCount: string;
  secondaryFlags: string[];
  /**
   * How many exceptions share this signature (§10.4) — so the model pitches the
   * wording at a recurring pattern, and the UI can say "this covers 14
   * exceptions" honestly.
   */
  occurrenceCount: number;
}

export interface ExplanationText {
  explanation: string;
  suggestedAction: string;
}

export type ExplainBatchResult =
  | {
    ok: true;
    /** Keyed by the batch-local `id`. May be a SUBSET — see `parseResponse`. */
    byId: Map<string, ExplanationText>;
    requestsMade: number;
    tokensIn: number | null;
    tokensOut: number | null;
  }
  | {
    ok: false;
    /** `malformed`: unparseable twice. `transport`: network/API/abort. */
    reason: 'malformed' | 'transport';
    detail: string;
    requestsMade: number;
  };

export interface ExplainLlmClient {
  /** The model this client calls. Hashed into every signature (ADR-018). */
  readonly model: string;
  explainBatch(signatures: readonly SignaturePrompt[]): Promise<ExplainBatchResult>;
}

/** The response schema, in the SDK's OpenAPI-flavoured dialect. */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    explanations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          explanation: { type: Type.STRING },
          suggested_action: { type: Type.STRING },
        },
        required: ['id', 'explanation', 'suggested_action'],
      },
    },
  },
  required: ['explanations'],
};

/**
 * The user message (§10.4).
 *
 * snake_case here is deliberate and is NOT a violation of §5's wire convention:
 * that rule governs the API's own JSON, and this is the prompt body quoted
 * verbatim from schema.md §10.4. Matching the doc keeps the prompt reviewable
 * against its spec.
 */
export function buildUserMessage(signatures: readonly SignaturePrompt[]): string {
  return JSON.stringify({
    signatures: signatures.map((s) => ({
      id: s.id,
      category: s.category,
      amount_delta: s.amountDelta,
      date_delta: s.dateDelta,
      sources_present: s.sourcesPresent,
      anchor_strength: s.anchorStrength,
      alias_involved: s.aliasInvolved,
      candidate_count: s.candidateCount,
      secondary_flags: s.secondaryFlags,
      occurrence_count: s.occurrenceCount,
    })),
  });
}

/**
 * Parse a response into the ids that were actually ASKED FOR.
 *
 * Three rules, each of which exists because the alternative is a lie in the UI:
 *
 *  1. **An id we did not ask about is DROPPED.** A response naming `sig_99` when
 *     the batch held `sig_1`…`sig_3` is the model inventing a subject, and
 *     fanning that text out would attach prose to an exception it was never
 *     written about.
 *  2. **A missing id is not an error.** A response covering 8 of 10 is not
 *     malformed JSON — §10.4's retry is for unparseable output. The 8 are used
 *     and the driver templates the other 2, which strictly beats discarding
 *     eight good explanations over two absent ones.
 *  3. **An empty or blank string is treated as absent**, so a template is
 *     written rather than an exception rendering a blank explanation panel.
 *
 * Returns `null` only when the payload is not usable at all — that is what the
 * single retry is for.
 */
export function parseResponse(
  text: string | undefined, askedFor: ReadonlySet<string>,
): Map<string, ExplanationText> | null {
  if (text === undefined || text.trim() === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const list = (parsed as Record<string, unknown>)['explanations'];
  if (!Array.isArray(list)) return null;

  const out = new Map<string, ExplanationText>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const id = row['id'];
    const explanation = row['explanation'];
    const suggestedAction = row['suggested_action'];
    if (typeof id !== 'string' || !askedFor.has(id)) continue;
    if (typeof explanation !== 'string' || explanation.trim() === '') continue;
    if (typeof suggestedAction !== 'string' || suggestedAction.trim() === '') continue;
    out.set(id, {
      explanation: explanation.trim(),
      suggestedAction: suggestedAction.trim(),
    });
  }
  return out;
}

export interface GeminiClientOptions {
  apiKey: string;
  model: string;
}

/**
 * The real client. `createExplainClient` below is what callers should use — it
 * returns `null` for the no-key case rather than making them check.
 */
export function createGeminiExplainClient(opts: GeminiClientOptions): ExplainLlmClient {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });

  return {
    model: opts.model,

    async explainBatch(signatures: readonly SignaturePrompt[]): Promise<ExplainBatchResult> {
      if (signatures.length === 0) {
        return { ok: true, byId: new Map(), requestsMade: 0, tokensIn: null, tokensOut: null };
      }
      const askedFor = new Set(signatures.map((s) => s.id));
      const contents = buildUserMessage(signatures);

      let requestsMade = 0;
      let lastDetail = 'no attempt was made';

      // §10.4: malformed JSON -> ONE retry at the same temperature -> give up.
      // Two attempts total, and both are counted.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let response;
        try {
          requestsMade += 1;
          response = await ai.models.generateContent({
            model: opts.model,
            contents,
            config: {
              systemInstruction: SYSTEM_PROMPT,
              // Determinism, as far as a model offers it. The engine's numbers do
              // not depend on this, but a re-run showing different prose for the
              // same signature would undermine the cache's whole story.
              temperature: 0,
              responseMimeType: 'application/json',
              responseSchema: RESPONSE_SCHEMA,
              abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            },
          });
        } catch (err) {
          // Transport is NOT retried here: a dead key, an exhausted quota or a
          // timeout will fail again the same way, and the retry §10.4 grants is
          // specifically for malformed output. Spending a second request on a
          // 401 would burn quota to learn nothing.
          return {
            ok: false, reason: 'transport', requestsMade,
            detail: err instanceof Error ? err.message : String(err),
          };
        }

        const byId = parseResponse(response.text, askedFor);
        if (byId !== null && byId.size > 0) {
          const usage = response.usageMetadata;
          return {
            ok: true, byId, requestsMade,
            tokensIn: usage?.promptTokenCount ?? null,
            tokensOut: usage?.candidatesTokenCount ?? null,
          };
        }
        lastDetail = byId === null
          ? `attempt ${attempt}: response was not usable JSON`
          : `attempt ${attempt}: response named none of the ${askedFor.size} signatures asked about`;
      }

      return { ok: false, reason: 'malformed', requestsMade, detail: lastDetail };
    },
  };
}

/**
 * The client for this environment, or `null` when there is nothing to call.
 *
 * `null` is a first-class, expected state — not a misconfiguration. The engine
 * has no key on most runs and must complete anyway, so the driver treats `null`
 * as "template everything" rather than as an error to report.
 */
export function createExplainClient(env: {
  geminiApiKey: string | null;
  explainModel: string;
  llmExplainEnabled: boolean;
}): ExplainLlmClient | null {
  if (!env.llmExplainEnabled) return null;
  if (env.geminiApiKey === null || env.geminiApiKey === '') return null;
  return createGeminiExplainClient({ apiKey: env.geminiApiKey, model: env.explainModel });
}
