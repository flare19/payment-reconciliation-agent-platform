/**
 * The ONE place that decides which provider the run talks to (ADR-093).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * BOTH SURFACES FOLLOW ONE SWITCH, AND THAT IS DELIBERATE.
 *
 * `/api/health` reports `llmConfigured` as a single boolean, and `env.ts`'s
 * `llmConfigured` reads one provider's key. If S13 could be on Anthropic while
 * Phase A was on Gemini, that boolean would be true while half the system had no
 * key — a run that looks configured and silently takes the template floor. One
 * switch makes that state unrepresentable.
 *
 * Gemini is kept rather than deleted: it is the free-tier path, and the ability
 * to run the whole system without spending a hard-capped prepaid balance is
 * worth one branch. `LLM_PROVIDER=gemini` restores Day 12 exactly.
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { ANTHROPIC_COST_PER_MILLION } from '../config/defaults.js';
import type { Env } from '../config/env.js';
import type { AgentLlmClient, CostModel } from './agent/agent-client.js';
import type { ExplainLlmClient } from './explain/llm-client.js';

import { createGeminiAgentClient } from './agent/gemini-agent-client.js';
import { createAnthropicAgentClient } from './agent/anthropic-agent-client.js';
import { createGeminiExplainClient } from './explain/llm-client.js';
import { createAnthropicExplainClient } from './explain/anthropic-explain-client.js';
import { withRateLimit, type RateLimitOptions } from './agent/rate-limiter.js';

type AgentEnv = Pick<Env,
  'llmProvider' | 'geminiApiKey' | 'anthropicApiKey' | 'agentModel' | 'agentEnabled'
  | 'agentEffort'> & {
    agentMaxRequestsPerMinute?: number;
    agentMaxTokensPerMinute?: number;
    agentMaxRetries?: number;
  };

/** The key for the CONFIGURED provider, or null. Never the other one's. */
function keyFor(env: Pick<Env, 'llmProvider' | 'geminiApiKey' | 'anthropicApiKey'>):
string | null {
  const key = env.llmProvider === 'anthropic' ? env.anthropicApiKey : env.geminiApiKey;
  return key === null || key === '' ? null : key;
}

export function createAgentClient(env: AgentEnv): AgentLlmClient | null {
  if (!env.agentEnabled) return null;
  const key = keyFor(env);
  if (key === null) return null;

  const inner = env.llmProvider === 'anthropic'
    ? createAnthropicAgentClient({ apiKey: key, model: env.agentModel, effort: env.agentEffort })
    : createGeminiAgentClient({ apiKey: key, model: env.agentModel });

  const limits: Partial<RateLimitOptions> = {
    ...(env.agentMaxRequestsPerMinute === undefined
      ? {} : { maxRequestsPerMinute: env.agentMaxRequestsPerMinute }),
    ...(env.agentMaxTokensPerMinute === undefined
      ? {} : { maxTokensPerMinute: env.agentMaxTokensPerMinute }),
    ...(env.agentMaxRetries === undefined ? {} : { maxRetries: env.agentMaxRetries }),
  };
  // The pacing layer is provider-neutral and wraps EITHER client. It reads
  // `retryable` and `retryAfterMs` off the turn result, which both clients set
  // from their own status codes.
  return withRateLimit(inner, limits).client;
}

export function createExplainClient(env: Pick<Env,
  'llmProvider' | 'geminiApiKey' | 'anthropicApiKey' | 'explainModel' | 'llmExplainEnabled'>,
): ExplainLlmClient | null {
  if (!env.llmExplainEnabled) return null;
  const key = keyFor(env);
  if (key === null) return null;
  return env.llmProvider === 'anthropic'
    ? createAnthropicExplainClient({ apiKey: key, model: env.explainModel })
    : createGeminiExplainClient({ apiKey: key, model: env.explainModel });
}

/**
 * Published rates for the configured model, or `null` when nothing is billed.
 *
 * NULL, never a zero or a guess. On the free tier there is no bill, and a `0.00`
 * cost in `agent_investigations` is indistinguishable from a priced run that
 * happened to cost nothing — the same rule `run-metrics.ts` applies to an unrun
 * stage. An unknown Anthropic model is also null rather than a guessed rate: a
 * made-up number in the ledger that guards real money is worse than an
 * acknowledged gap.
 */
export function costModelFor(env: Pick<Env, 'llmProvider' | 'agentModel'>): CostModel | null {
  if (env.llmProvider !== 'anthropic') return null;
  const rates = (ANTHROPIC_COST_PER_MILLION as Record<string, CostModel | undefined>)[
    env.agentModel];
  return rates ?? null;
}
