/**
 * S13's Anthropic client (ADR-093). One implementation of `ExplainLlmClient`.
 *
 * Reuses `buildUserMessage`, `parseResponse` and `findUngroundedSpecific`
 * verbatim — the batching, the id discipline, the §10.4 single retry and #52's
 * grounding check are provider-neutral and stay that way. This file owns the
 * request shape and nothing else.
 *
 * ── THE `maxRequests` CONTRACT IS THE POINT ──
 * `LLM_MAX_CALLS_PER_RUN` is a TRUE ceiling only if the retry is inside it. A
 * budget of 1 must spend at most 1, forgoing the retry and taking the template
 * floor. Copied from the Gemini client's contract, not re-derived.
 *
 * ── NO THINKING HERE, DELIBERATELY ──
 * S13 writes two sentences about a decision the rules already made (ADR-017).
 * There is nothing to reason about, and thinking tokens bill as output at 5x the
 * input rate. `effort: 'low'` for the same reason. This is the cheapest surface
 * in the project and it should stay that way.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  MAX_SIGNATURES_PER_REQUEST, buildUserMessage, parseResponse,
  type ExplainBatchResult, type ExplainLlmClient, type SignaturePrompt,
} from './llm-client.js';
import { SYSTEM_PROMPT } from './templates.js';

export interface AnthropicExplainClientOptions {
  apiKey: string;
  model: string;
  /** Bounded because §10.4 caps the explanation at 2-3 sentences per signature. */
  maxOutputTokens?: number;
  sdk?: Pick<Anthropic, 'messages'>;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export function createAnthropicExplainClient(
  opts: AnthropicExplainClientOptions,
): ExplainLlmClient {
  const sdk = opts.sdk ?? new Anthropic({ apiKey: opts.apiKey });
  const maxTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  return {
    model: opts.model,
    async explainBatch(
      signatures: readonly SignaturePrompt[], { maxRequests }: { maxRequests: number },
    ): Promise<ExplainBatchResult> {
      if (signatures.length > MAX_SIGNATURES_PER_REQUEST) {
        // The driver chunks; this is a programming error, not a model failure.
        throw new Error(
          `explainBatch received ${signatures.length} signatures, above the `
          + `${MAX_SIGNATURES_PER_REQUEST} cap`);
      }
      if (maxRequests < 1) {
        return { ok: false, reason: 'transport', detail: 'no request budget left', requestsMade: 0 };
      }

      const askedFor = new Set(signatures.map((s) => s.id));
      const userMessage = buildUserMessage(signatures);
      let requestsMade = 0;
      let tokensIn = 0;
      let tokensOut = 0;
      let lastDetail = 'no attempt was made';

      // §10.4: unparseable output earns ONE retry, and the retry is inside the
      // caller's budget rather than on top of it.
      const attempts = Math.min(2, maxRequests);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        let response: Anthropic.Message;
        try {
          requestsMade += 1;
          response = await sdk.messages.create({
            model: opts.model,
            max_tokens: maxTokens,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userMessage }],
            output_config: { effort: 'low' },
          });
        } catch (err) {
          lastDetail = err instanceof Error ? err.message : String(err);
          // A transport failure is not a parse failure, and retrying it is the
          // pacing layer's job, not ours.
          return { ok: false, reason: 'transport', detail: lastDetail, requestsMade };
        }

        tokensIn += response.usage.input_tokens
          + (response.usage.cache_read_input_tokens ?? 0)
          + (response.usage.cache_creation_input_tokens ?? 0);
        tokensOut += response.usage.output_tokens;

        if (response.stop_reason === 'refusal') {
          return {
            ok: false, reason: 'transport',
            detail: `the model declined: ${response.stop_details?.explanation ?? 'no reason given'}`,
            requestsMade,
          };
        }

        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text).join('\n');

        const byId = parseResponse(text, askedFor);
        if (byId !== null) return { ok: true, byId, requestsMade, tokensIn, tokensOut };
        lastDetail = 'the response was not usable JSON';
      }

      return { ok: false, reason: 'malformed', detail: lastDetail, requestsMade };
    },
  };
}
