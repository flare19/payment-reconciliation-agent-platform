/**
 * Environment parsing. One place, validated at boot, typed thereafter.
 *
 * Fail fast on a missing REQUIRED var — a server that starts and then 500s on
 * every request is harder to diagnose than one that refuses to start and says why.
 * Optional vars degrade explicitly (see `llmConfigured`).
 */

import {
  AGENT_DEFAULTS, DEFAULT_AGENT_MODEL, DEFAULT_ANTHROPIC_AGENT_MODEL,
  DEFAULT_ANTHROPIC_EXPLAIN_MODEL, DEFAULT_EXPLAIN_MODEL, DEFAULT_PROMPT_VERSION,
} from './defaults.js';
import { RATE_LIMIT_DEFAULTS } from '../services/agent/rate-limiter.js';

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
      `Copy .env.example to .env and fill it in (docs/deployment.md §3).`,
    );
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`Environment variable ${name} must be an integer, got "${v}"`);
  return n;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number, got "${v}"`);
  return n;
}

export interface Env {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  /** Exact origins. NEVER `*` — see deployment.md §3. */
  corsOrigins: string[];
  logLevel: string;

  /** ONE key, both layers. Null is a legitimate state — see `llmConfigured`. */
  /**
   * ADR-093: `anthropic` is the shipped provider; `gemini` is kept so the
   * free-tier path still runs without a paid key. One switch, both surfaces —
   * a per-surface provider would let S13 and Phase A disagree about what
   * `llmConfigured` means, which the health endpoint reports as one boolean.
   */
  llmProvider: 'anthropic' | 'gemini';
  geminiApiKey: string | null;
  anthropicApiKey: string | null;
  /** ADR-093: `output_config.effort` for the Analyst. Not used by S13. */
  agentEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** S13 explain (ADR-080). The signature hash includes it, so a change invalidates the cache. */
  explainModel: string;
  /** Phase A investigation and Q&A loops (ADR-080). */
  agentModel: string;
  agentMaxRequestsPerMinute: number;
  agentMaxTokensPerMinute: number;
  agentMaxRetries: number;
  llmExplainEnabled: boolean;
  llmMaxCallsPerRun: number;
  promptVersion: string;

  aliasLearningEnabled: boolean;
  candidateCap: number;
  batchSubsetBudgetMs: number;
  runMigrationsOnBoot: boolean;
  staleRunTimeoutMinutes: number;

  agentEnabled: boolean;
  agentMaxInvestigationsPerRun: number;
  agentMaxCostUsdPerRun: number;
  /**
   * The DEPLOYMENT-wide ceiling for the public investigate endpoint (#61).
   *
   * A per-RUN cap cannot bound an unauthenticated surface: `POST /api/runs`
   * mints a fresh run on demand, so "per run" is a ceiling the caller controls.
   * This one is per WALL-CLOCK HOUR and is the only bound an anonymous visitor
   * cannot reset.
   */
  agentMaxCostUsdPerHour: number;
  /**
   * The bound that actually binds on a free tier (ADR-080).
   *
   * `agentMaxCostUsdPerRun` protects a credit card. On a free-tier key there is
   * no bill to cap and the scarce resource is REQUESTS PER DAY, so a cost
   * ceiling of $1.00 is satisfied by a run that exhausts the day's quota. This
   * one is counted and enforced whether or not the key is billed.
   */
  agentMaxLlmRequestsPerRun: number;
  /** Review-queue corroborations per run (ADR-081). Shares the request budget above. */
  agentMaxQueueTriagesPerRun: number;
  agentQaEnabled: boolean;
  agentQaMaxQuestionsPerRun: number;
  agentQaMaxQuestionsPerHour: number;
  agentPromptVersion: string;

  devSeed: number;
  holdoutSeed: number;
}

const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function loadEnv(): Env {
  const key = process.env['GEMINI_API_KEY'];
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  // Defaults to anthropic (ADR-093). An unset LLM_PROVIDER on a machine holding
  // only a Gemini key would otherwise report `llmConfigured: false` and silently
  // take the template floor — a wrong-looking run with no error.
  const rawProvider = optional('LLM_PROVIDER', 'anthropic');
  if (rawProvider !== 'anthropic' && rawProvider !== 'gemini') {
    throw new Error(`LLM_PROVIDER must be 'anthropic' or 'gemini', got '${rawProvider}'`);
  }
  const provider: 'anthropic' | 'gemini' = rawProvider;

  const rawEffort = optional('AGENT_EFFORT', 'high');
  if (!(AGENT_EFFORTS as readonly string[]).includes(rawEffort)) {
    throw new Error(
      `AGENT_EFFORT must be one of ${AGENT_EFFORTS.join(', ')}, got '${rawEffort}'`);
  }
  const effort = rawEffort as Env['agentEffort'];

  return {
    nodeEnv: optional('NODE_ENV', 'development'),
    // Railway injects PORT. Binding a hardcoded port is the single most common
    // first-deploy failure (deployment.md §3).
    port: int('PORT', 8080),
    databaseUrl: required('DATABASE_URL'),
    corsOrigins: required('CORS_ORIGIN').split(',').map((s) => s.trim()).filter(Boolean),
    logLevel: optional('LOG_LEVEL', 'info'),

    llmProvider: provider,
    geminiApiKey: key === undefined || key === '' ? null : key,
    anthropicApiKey: anthropicKey === undefined || anthropicKey === '' ? null : anthropicKey,
    agentEffort: effort,
    // The model defaults follow the provider, so switching LLM_PROVIDER does not
    // also require remembering to change two model names.
    explainModel: optional('LLM_EXPLAIN_MODEL',
      optional('GEMINI_EXPLAIN_MODEL',
        provider === 'anthropic' ? DEFAULT_ANTHROPIC_EXPLAIN_MODEL : DEFAULT_EXPLAIN_MODEL)),
    agentModel: optional('LLM_AGENT_MODEL',
      optional('GEMINI_AGENT_MODEL',
        provider === 'anthropic' ? DEFAULT_ANTHROPIC_AGENT_MODEL : DEFAULT_AGENT_MODEL)),
    llmExplainEnabled: bool('LLM_EXPLAIN_ENABLED', true),
    llmMaxCallsPerRun: int('LLM_MAX_CALLS_PER_RUN', 8),
    promptVersion: optional('PROMPT_VERSION', DEFAULT_PROMPT_VERSION),

    aliasLearningEnabled: bool('ALIAS_LEARNING_ENABLED', true),
    candidateCap: int('CANDIDATE_CAP', 200),
    batchSubsetBudgetMs: int('BATCH_SUBSET_BUDGET_MS', 2_000),
    runMigrationsOnBoot: bool('RUN_MIGRATIONS_ON_BOOT', true),
    staleRunTimeoutMinutes: int('STALE_RUN_TIMEOUT_MINUTES', 5),

    agentEnabled: bool('AGENT_ENABLED', true),
    agentMaxInvestigationsPerRun: int('AGENT_MAX_INVESTIGATIONS_PER_RUN', AGENT_DEFAULTS.maxInvestigationsPerRun),
    agentMaxCostUsdPerRun: num('AGENT_MAX_COST_USD_PER_RUN', 1.0),
    agentMaxCostUsdPerHour: num('AGENT_MAX_COST_USD_PER_HOUR', 2.0),
    agentMaxLlmRequestsPerRun: int('AGENT_MAX_LLM_REQUESTS_PER_RUN', AGENT_DEFAULTS.maxLlmRequestsPerRun),
    agentMaxQueueTriagesPerRun: int('AGENT_MAX_QUEUE_TRIAGES_PER_RUN', AGENT_DEFAULTS.maxQueueTriagesPerRun),
    agentQaEnabled: bool('AGENT_QA_ENABLED', true),
    agentQaMaxQuestionsPerRun: int('AGENT_QA_MAX_QUESTIONS_PER_RUN', 50),
    agentQaMaxQuestionsPerHour: int('AGENT_QA_MAX_QUESTIONS_PER_HOUR', 100),
    agentPromptVersion: optional('AGENT_PROMPT_VERSION', 'agent-v1'),
    // Paced BELOW the provider ceiling on purpose (rate-limiter.ts). A refused
    // request still counts against a daily quota, so the margin is what keeps
    // the budget being spent on work rather than on rejections.
    agentMaxRequestsPerMinute:
      int('AGENT_MAX_REQUESTS_PER_MINUTE', RATE_LIMIT_DEFAULTS.maxRequestsPerMinute),
    agentMaxTokensPerMinute:
      int('AGENT_MAX_TOKENS_PER_MINUTE', RATE_LIMIT_DEFAULTS.maxTokensPerMinute),
    agentMaxRetries: int('AGENT_MAX_RETRIES', RATE_LIMIT_DEFAULTS.maxRetries),

    devSeed: int('DEV_SEED', 1337),
    holdoutSeed: int('HOLDOUT_SEED', 90210),
  };
}

/** Boolean only — never a prefix, never a masked fragment (deployment.md §4.6). */
export function llmConfigured(env: Env): boolean {
  return env.llmProvider === 'anthropic'
    ? env.anthropicApiKey !== null
    : env.geminiApiKey !== null;
}
