/**
 * Environment parsing. One place, validated at boot, typed thereafter.
 *
 * Fail fast on a missing REQUIRED var — a server that starts and then 500s on
 * every request is harder to diagnose than one that refuses to start and says why.
 * Optional vars degrade explicitly (see `llmConfigured`).
 */

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

  anthropicApiKey: string | null;
  anthropicModel: string;
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
  agentQaEnabled: boolean;
  agentQaMaxQuestionsPerRun: number;
  agentQaMaxQuestionsPerHour: number;
  agentPromptVersion: string;

  devSeed: number;
  holdoutSeed: number;
}

export function loadEnv(): Env {
  const key = process.env['ANTHROPIC_API_KEY'];
  return {
    nodeEnv: optional('NODE_ENV', 'development'),
    // Railway injects PORT. Binding a hardcoded port is the single most common
    // first-deploy failure (deployment.md §3).
    port: int('PORT', 8080),
    databaseUrl: required('DATABASE_URL'),
    corsOrigins: required('CORS_ORIGIN').split(',').map((s) => s.trim()).filter(Boolean),
    logLevel: optional('LOG_LEVEL', 'info'),

    anthropicApiKey: key === undefined || key === '' ? null : key,
    anthropicModel: optional('ANTHROPIC_MODEL', 'claude-sonnet-5'),
    llmExplainEnabled: bool('LLM_EXPLAIN_ENABLED', true),
    llmMaxCallsPerRun: int('LLM_MAX_CALLS_PER_RUN', 8),
    promptVersion: optional('PROMPT_VERSION', 'v1'),

    aliasLearningEnabled: bool('ALIAS_LEARNING_ENABLED', true),
    candidateCap: int('CANDIDATE_CAP', 200),
    batchSubsetBudgetMs: int('BATCH_SUBSET_BUDGET_MS', 250),
    runMigrationsOnBoot: bool('RUN_MIGRATIONS_ON_BOOT', true),
    staleRunTimeoutMinutes: int('STALE_RUN_TIMEOUT_MINUTES', 5),

    agentEnabled: bool('AGENT_ENABLED', true),
    agentMaxInvestigationsPerRun: int('AGENT_MAX_INVESTIGATIONS_PER_RUN', 20),
    agentMaxCostUsdPerRun: num('AGENT_MAX_COST_USD_PER_RUN', 1.0),
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
  return env.anthropicApiKey !== null;
}
