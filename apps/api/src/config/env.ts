/**
 * Environment parsing. One place, validated at boot, typed thereafter.
 *
 * Fail fast on a missing REQUIRED var — a server that starts and then 500s on
 * every request is harder to diagnose than one that refuses to start and says why.
 * Optional vars degrade explicitly (see `llmConfigured`).
 */

import { AGENT_DEFAULTS, DEFAULT_EXPLAIN_MODEL, DEFAULT_PROMPT_VERSION } from './defaults.js';

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
  geminiApiKey: string | null;
  /** S13 explain (ADR-080). The signature hash includes it, so a change invalidates the cache. */
  explainModel: string;
  /** Phase A investigation and Q&A loops (ADR-080). */
  agentModel: string;
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

export function loadEnv(): Env {
  const key = process.env['GEMINI_API_KEY'];
  return {
    nodeEnv: optional('NODE_ENV', 'development'),
    // Railway injects PORT. Binding a hardcoded port is the single most common
    // first-deploy failure (deployment.md §3).
    port: int('PORT', 8080),
    databaseUrl: required('DATABASE_URL'),
    corsOrigins: required('CORS_ORIGIN').split(',').map((s) => s.trim()).filter(Boolean),
    logLevel: optional('LOG_LEVEL', 'info'),

    geminiApiKey: key === undefined || key === '' ? null : key,
    explainModel: optional('GEMINI_EXPLAIN_MODEL', DEFAULT_EXPLAIN_MODEL),
    agentModel: optional('GEMINI_AGENT_MODEL', 'gemini-3.7-flash'),
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
    agentMaxLlmRequestsPerRun: int('AGENT_MAX_LLM_REQUESTS_PER_RUN', AGENT_DEFAULTS.maxLlmRequestsPerRun),
    agentMaxQueueTriagesPerRun: int('AGENT_MAX_QUEUE_TRIAGES_PER_RUN', AGENT_DEFAULTS.maxQueueTriagesPerRun),
    agentQaEnabled: bool('AGENT_QA_ENABLED', true),
    agentQaMaxQuestionsPerRun: int('AGENT_QA_MAX_QUESTIONS_PER_RUN', 50),
    agentQaMaxQuestionsPerHour: int('AGENT_QA_MAX_QUESTIONS_PER_HOUR', 100),
    agentPromptVersion: optional('AGENT_PROMPT_VERSION', 'agent-v1'),

    devSeed: int('DEV_SEED', 1337),
    holdoutSeed: int('HOLDOUT_SEED', 90210),
  };
}

/** Boolean only — never a prefix, never a masked fragment (deployment.md §4.6). */
export function llmConfigured(env: Env): boolean {
  return env.geminiApiKey !== null;
}
