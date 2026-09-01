/**
 * The Analyst's Anthropic client (ADR-093). One implementation of
 * `AgentLlmClient`; nothing else in Phase A knows a provider exists.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE SWAP IS SMALL BY CONSTRUCTION, AND THIS FILE IS THE PROOF.
 *
 * `investigation-loop.ts` enforces every §8 bound, `grounding-gate.ts` validates
 * every verdict, `phase-a.ts` persists them and `rate-limiter.ts` paces them —
 * and none of those four contains a provider type. All of that survives the swap
 * untouched. What changes is here: message mapping, tool declaration shape, and
 * how a failure is classified.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── THINKING BLOCKS ARE REPLAYED VERBATIM, VIA `providerSignature` ──
 * Anthropic requires thinking blocks passed back unchanged on the same model,
 * exactly as Gemini 3.x required its `thought_signature`. `AgentToolCall` already
 * carries an opaque `providerSignature` for precisely this, and its doc comment
 * predicted this would survive the provider change. It does: the whole thinking
 * block is serialised into it and replayed. The loop still may not inspect it.
 *
 * ── ADAPTIVE THINKING, NOT A TOKEN BUDGET ──
 * `budget_tokens` is REMOVED on Sonnet 5 and returns a 400. Depth is controlled
 * by `output_config.effort`. Sampling parameters (`temperature`, `top_p`) are
 * also removed — the old `temperature: 0` determinism lever is gone, and ADR-048
 * never depended on it: the ENGINE is deterministic, the Analyst never was.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  ZERO_USAGE, type AgentLlmClient, type AgentMessage, type AgentToolCall,
  type AgentTurnRequest, type AgentTurnResult, type AgentUsage, type ToolDeclaration,
} from './agent-client.js';

/** What `output_config.effort` accepts on Sonnet 5. */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicAgentClientOptions {
  apiKey: string;
  model: string;
  effort: AgentEffort;
  /** Injected in tests. */
  sdk?: Pick<Anthropic, 'messages'>;
}

/**
 * A thinking or redacted-thinking block, carried across turns.
 *
 * Serialised into `providerSignature` rather than given a field of its own,
 * because `AgentToolCall` is the provider-neutral shape the loop persists and
 * widening it would leak Anthropic into `types/agent.ts`.
 */
function encodeSignature(blocks: unknown[]): string | undefined {
  return blocks.length === 0 ? undefined : JSON.stringify(blocks);
}

function decodeSignature(sig: string | undefined): unknown[] {
  if (sig === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(sig);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Provider-neutral history -> Anthropic `messages`. */
export function toAnthropicMessages(
  messages: readonly AgentMessage[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
      continue;
    }
    if (m.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      // Thinking blocks must come FIRST and be replayed unchanged. They are
      // carried on the first tool call's `providerSignature`.
      for (const block of decodeSignature(m.toolCalls[0]?.providerSignature)) {
        content.push(block as Anthropic.ContentBlockParam);
      }
      if (m.text.trim() !== '') content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      }
      // An assistant turn with no content at all is rejected; skip rather than
      // send an empty array.
      if (content.length > 0) out.push({ role: 'assistant', content });
      continue;
    }
    // A tool result. Consecutive results are merged into ONE user message:
    // splitting parallel results across messages teaches the model to stop
    // making parallel calls.
    const block: Anthropic.ToolResultBlockParam = {
      type: 'tool_result', tool_use_id: m.callId, content: m.content,
    };
    const last = out[out.length - 1];
    if (last !== undefined && last.role === 'user' && Array.isArray(last.content)) {
      (last.content as Anthropic.ContentBlockParam[]).push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

export function toAnthropicTools(
  tools: readonly ToolDeclaration[],
): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Classify a failure. `retryable` is set HERE because only this file can read a
 * status code, and `rate-limiter.ts` is provider-neutral and must not parse
 * `detail` to guess (`agent-client.ts`).
 */
function classify(err: unknown): {
  reason: 'transport' | 'refused'; detail: string;
  retryable?: boolean; retryAfterMs?: number;
} {
  if (err instanceof Anthropic.RateLimitError) {
    const header = err.headers?.get?.('retry-after');
    const seconds = header === null || header === undefined ? NaN : Number(header);
    return {
      reason: 'transport', detail: `rate limited: ${err.message}`, retryable: true,
      ...(Number.isFinite(seconds) ? { retryAfterMs: seconds * 1000 } : {}),
    };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return { reason: 'refused', detail: `authentication failed: ${err.message}` };
  }
  if (err instanceof Anthropic.BadRequestError) {
    // Our bug, not a blip. Retrying an invalid request spends quota to be told
    // the same thing again.
    return { reason: 'refused', detail: `invalid request: ${err.message}` };
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    return {
      reason: 'transport', detail: `api error ${status}: ${err.message}`,
      retryable: status >= 500,
    };
  }
  return {
    reason: 'transport',
    detail: err instanceof Error ? err.message : String(err),
  };
}

export function createAnthropicAgentClient(
  opts: AnthropicAgentClientOptions,
): AgentLlmClient {
  const sdk = opts.sdk ?? new Anthropic({ apiKey: opts.apiKey });

  return {
    model: opts.model,
    async turn(request: AgentTurnRequest): Promise<AgentTurnResult> {
      let response: Anthropic.Message;
      try {
        response = await sdk.messages.create({
          model: opts.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          tools: toAnthropicTools(request.tools),
          // Adaptive thinking: the only on-mode on Sonnet 5. `budget_tokens` is
          // removed and returns a 400.
          thinking: { type: 'adaptive' },
          output_config: { effort: opts.effort },
        });
      } catch (err) {
        // Usage is ZERO, not an estimate. A request that failed before the model
        // read it cost nothing, and booking a made-up number into the ledger
        // that guards real money is worse than an honest gap.
        return { ok: false, ...classify(err), usage: { ...ZERO_USAGE } };
      }

      const usage: AgentUsage = {
        tokensIn: response.usage.input_tokens
          + (response.usage.cache_read_input_tokens ?? 0)
          + (response.usage.cache_creation_input_tokens ?? 0),
        tokensOut: response.usage.output_tokens,
      };

      // A safety decline is a REFUSAL, not a transport fault: retrying it spends
      // quota to be refused again.
      if (response.stop_reason === 'refusal') {
        return {
          ok: false, reason: 'refused',
          detail: `the model declined: ${response.stop_details?.explanation ?? 'no reason given'}`,
          usage,
        };
      }

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text).join('\n').trim();

      // TRUNCATION IS NOT A CONCLUSION. `max_tokens` counts THINKING tokens too
      // on an adaptive-thinking model, so a turn can spend its whole output
      // allowance reasoning and return a half-written verdict — which parses to
      // nothing and reads, in the audit trail, exactly like a model that
      // answered in prose. Two very different defects with one symptom, so the
      // client names which one it was rather than leaving the loop to guess.
      if (response.stop_reason === 'max_tokens') {
        return {
          ok: false, reason: 'transport',
          detail: `the reply was cut off at the ${request.maxOutputTokens}-output-token `
            + 'ceiling (thinking tokens count toward it), so no verdict was returned',
          usage, retryable: false,
        };
      }

      const toolUses = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

      if (toolUses.length === 0) return { ok: true, kind: 'final', text, usage };

      // Thinking blocks ride on the FIRST call's signature and are replayed
      // ahead of everything else in that assistant turn.
      const thinking = response.content.filter(
        (b) => b.type === 'thinking' || b.type === 'redacted_thinking');
      const calls: AgentToolCall[] = toolUses.map((b, i) => ({
        id: b.id,
        name: b.name,
        args: (b.input ?? {}) as Record<string, unknown>,
        ...(i === 0
          ? (() => {
            const sig = encodeSignature(thinking);
            return sig === undefined ? {} : { providerSignature: sig };
          })()
          : {}),
      }));
      return { ok: true, kind: 'tool_call', text, calls, usage };
    },
  };
}
