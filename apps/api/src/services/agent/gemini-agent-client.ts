/**
 * `AgentLlmClient` over Gemini function calling (ADR-080). U13.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THIS FILE IS THE ONLY PART OF PHASE A THAT KNOWS WHICH PROVIDER IT IS TALKING
 * TO.
 *
 * The loop, the bounds, the audit trail and the grounding plumbing are all
 * written against `AgentLlmClient` and contain no provider types. Swapping to
 * another provider is a sibling file and a constructor change — which is the
 * whole reason the interface exists, since ADR-080's own "Revisit if" clause
 * anticipates exactly that swap.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── IT NEVER THROWS ──
 * Every failure is an `{ ok: false }` value carrying whatever usage was already
 * spent. A transport error mid-investigation must become an honest
 * `INSUFFICIENT_EVIDENCE`, not an exception that kills the phase (ADR-048).
 *
 * ── NO AUTOMATIC TOOL LOOP (§3) ──
 * This client performs exactly ONE turn per call. It does not execute tools and
 * does not iterate. The loop in `investigation-loop.ts` owns the turn boundary
 * because that is where §8's bounds are enforced; a client that looped
 * internally would hide the place the bounds live.
 */

import { GoogleGenAI, type Content, type FunctionDeclaration } from '@google/genai';

import type {
  AgentLlmClient, AgentMessage, AgentTurnRequest, AgentTurnResult, AgentUsage,
  ToolDeclaration,
} from './agent-client.js';
import { withRateLimit, type RateLimitOptions } from './rate-limiter.js';

/**
 * Per-turn wall clock.
 *
 * 90 s, not the explain layer's 60 s, and the difference is deliberate: an
 * agent turn carries a growing history plus nine tool schemas, so its inputs are
 * an order of magnitude larger than an explain batch's. Sized the way the
 * explain timeout was RE-sized after it fired on working responses — with
 * headroom above the expected time rather than close to it. §8's own 60 s
 * bound governs the WHOLE investigation and is enforced by the loop; this one
 * only stops a single hung connection, so it is deliberately looser than the
 * bound that actually matters.
 */
const TURN_TIMEOUT_MS = 90_000;

function toGeminiTools(tools: readonly ToolDeclaration[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // `parametersJsonSchema` rather than `parameters`: the registry already
    // emits plain JSON Schema, and re-encoding it into the SDK's `Schema`
    // dialect would be a second copy of every tool's shape — the drift risk
    // ADR-049's single-implementation rule exists to avoid.
    parametersJsonSchema: t.parameters,
  }));
}

/** Our provider-neutral history, in Gemini's `Content[]` shape. */
function toContents(messages: readonly AgentMessage[]): Content[] {
  const out: Content[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.text }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [
        ...(m.text.trim() === '' ? [] : [{ text: m.text }]),
        ...m.toolCalls.map((c) => ({
          functionCall: { id: c.id, name: c.name, args: c.args },
          // Replayed VERBATIM. Gemini 3.x rejects the next request with a 400
          // if a replayed functionCall has lost its thought signature, so this
          // is not optional bookkeeping — it is what makes a multi-step tool
          // loop work at all on these models.
          ...(c.providerSignature === undefined
            ? {} : { thoughtSignature: c.providerSignature }),
        })),
      ];
      // A model turn with neither text nor a call cannot be replayed; skipping
      // it is better than sending an empty `parts`, which the API rejects.
      if (parts.length > 0) out.push({ role: 'model', parts });
      continue;
    }
    out.push({
      role: 'user',
      parts: [{
        functionResponse: {
          id: m.callId,
          name: m.toolName,
          // The tool's own JSON, passed through. The client never summarises a
          // tool result — the model must see what the tool returned, including
          // the `resultDigest` A3 will ask it to echo back.
          response: { content: m.content },
        },
      }],
    });
  }
  return out;
}

/**
 * The `thoughtSignature` Gemini attached to a function-call part.
 *
 * Read off the raw parts rather than the `functionCalls` accessor, which
 * projects to `FunctionCall` and drops the sibling field. Matched by tool name:
 * within one turn a model does not call the same tool twice with different
 * signatures in a way that matters here, and the alternative — index-matching
 * two differently-shaped arrays — is the more fragile pairing.
 */
function signatureFor(
  response: { candidates?: { content?: { parts?: {
    functionCall?: { name?: string }; thoughtSignature?: string }[] } }[] },
  toolName: string | undefined,
): string | undefined {
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.functionCall?.name === toolName && part.thoughtSignature !== undefined) {
      return part.thoughtSignature;
    }
  }
  return undefined;
}

/**
 * Whether a thrown SDK error is worth sending again, and when.
 *
 * ── WHY THIS READS A STATUS AND NOT A MESSAGE ──
 * `rate-limiter.ts` is provider-neutral and must not sniff error strings, so the
 * translation from "what Google said" to "is this retryable" belongs here, in
 * the one file allowed to know the provider. The limiter consumes the boolean.
 *
 * ── THE LIST IS DELIBERATELY SHORT ──
 * 429 and the transient 5xx family only. A 400 means the request itself is
 * wrong — replaying it burns quota to be told the same thing, and this is
 * exactly how a missing `thought_signature` presented. A timeout is excluded
 * too: `TURN_TIMEOUT_MS` is 90 s, so a retry costs three minutes to maybe
 * discover the same hung connection, and the loop already degrades a dead turn
 * into an honest INSUFFICIENT_EVIDENCE.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export function classifyTransportError(
  err: unknown,
): { retryable: boolean; retryAfterMs?: number } {
  // An aborted turn is our own timeout firing, never the provider's verdict.
  if (err instanceof Error
    && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return { retryable: false };
  }

  const message = err instanceof Error ? err.message : String(err);
  // The SDK surfaces the HTTP status on the error where it can; the message
  // carries the JSON body otherwise. Both are checked because neither is
  // guaranteed, and guessing wrong in the retryable direction spends quota.
  const statusField = (err as { status?: unknown } | null)?.status;
  const fromField = typeof statusField === 'number' ? statusField : null;
  const fromBody = /"code"\s*:\s*(\d{3})/.exec(message)?.[1];
  const status = fromField ?? (fromBody === undefined ? null : Number(fromBody));

  const retryable = status === null
    ? /RESOURCE_EXHAUSTED|UNAVAILABLE/.test(message)
    : RETRYABLE_STATUSES.has(status);
  if (!retryable) return { retryable: false };

  // Google returns RetryInfo as `"retryDelay": "39s"`. Honoured verbatim when
  // present — it knows when the quota refills and we do not.
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message)?.[1];
  return delay === undefined
    ? { retryable: true }
    : { retryable: true, retryAfterMs: Math.ceil(Number(delay) * 1000) };
}

function usageOf(meta: {
  promptTokenCount?: number; candidatesTokenCount?: number;
} | undefined): AgentUsage {
  return {
    tokensIn: meta?.promptTokenCount ?? 0,
    tokensOut: meta?.candidatesTokenCount ?? 0,
  };
}

export interface GeminiAgentOptions {
  apiKey: string;
  model: string;
}

export function createGeminiAgentClient(opts: GeminiAgentOptions): AgentLlmClient {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });

  return {
    model: opts.model,

    async turn(request: AgentTurnRequest): Promise<AgentTurnResult> {
      let response;
      try {
        response = await ai.models.generateContent({
          model: opts.model,
          contents: toContents(request.messages),
          config: {
            systemInstruction: request.system,
            // Determinism as far as a model offers it. The engine's numbers do
            // not depend on this — ADR-017 keeps the model out of every
            // decision — but a re-run producing a wholly different
            // investigation would make the reasoning chain harder to trust.
            temperature: 0,
            maxOutputTokens: request.maxOutputTokens,
            tools: [{ functionDeclarations: toGeminiTools(request.tools) }],
            abortSignal: AbortSignal.timeout(TURN_TIMEOUT_MS),
          },
        });
      } catch (err) {
        return {
          ok: false, reason: 'transport',
          detail: err instanceof Error ? err.message : String(err),
          ...classifyTransportError(err),
          // The request may have reached the model before failing, but the SDK
          // gives no usage on a throw. Reported as zero and NOT invented — an
          // estimated token count in a spend ledger is worse than a known gap.
          usage: { tokensIn: 0, tokensOut: 0 },
        };
      }

      const usage = usageOf(response.usageMetadata);
      const calls = response.functionCalls ?? [];
      const text = response.text ?? '';

      if (calls.length > 0) {
        return {
          ok: true, kind: 'tool_call', text,
          calls: calls.map((c, i) => {
            const signature = signatureFor(response, c.name);
            return {
              // Gemini may omit the id; the loop needs one to pair the result
              // back, so a positional fallback keeps the pairing total.
              id: c.id ?? `call_${i + 1}`,
              name: c.name ?? '',
              args: c.args ?? {},
              ...(signature === undefined ? {} : { providerSignature: signature }),
            };
          }),
          usage,
        };
      }

      if (text.trim() === '') {
        // Neither a call nor text. Treated as a failed turn rather than an empty
        // conclusion, because an empty final message would be parsed as "no
        // usable verdict" and blamed on the model's JSON rather than on the
        // turn having produced nothing at all.
        return {
          ok: false, reason: 'refused',
          detail: `the model returned neither a tool call nor text `
            + `(finishReason: ${response.candidates?.[0]?.finishReason ?? 'unknown'})`,
          usage,
        };
      }

      return { ok: true, kind: 'final', text, usage };
    },
  };
}

/**
 * `null` when Phase A has no key or is switched off — a legitimate state.
 *
 * The returned client is PACED. Pacing is applied here rather than left to the
 * caller so there is no unpaced path to the provider: a route that built a raw
 * client would spend the day's quota on 429s and nobody would notice until the
 * run stopped producing verdicts.
 */
export function createAgentClient(env: {
  geminiApiKey: string | null;
  agentModel: string;
  agentEnabled: boolean;
  agentMaxRequestsPerMinute?: number;
  agentMaxTokensPerMinute?: number;
  agentMaxRetries?: number;
}): AgentLlmClient | null {
  if (!env.agentEnabled) return null;
  if (env.geminiApiKey === null || env.geminiApiKey === '') return null;
  const limits: Partial<RateLimitOptions> = {
    ...(env.agentMaxRequestsPerMinute === undefined
      ? {} : { maxRequestsPerMinute: env.agentMaxRequestsPerMinute }),
    ...(env.agentMaxTokensPerMinute === undefined
      ? {} : { maxTokensPerMinute: env.agentMaxTokensPerMinute }),
    ...(env.agentMaxRetries === undefined ? {} : { maxRetries: env.agentMaxRetries }),
  };
  return withRateLimit(
    createGeminiAgentClient({ apiKey: env.geminiApiKey, model: env.agentModel }),
    limits,
  ).client;
}
