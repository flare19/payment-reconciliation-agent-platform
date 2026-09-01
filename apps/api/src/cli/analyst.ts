/**
 * `npm run analyst` — Phase A over a finished run, from the command line.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY A CLI AND NOT A ROUTE
 *
 * ADR-048: nothing in Phase A may appear in S0–S14, and the engine must run
 * identically with `AGENT_ENABLED=false`. So the Analyst cannot live in the
 * orchestrator, and endpoint 25 deliberately investigates ONE exception. That
 * left the full phase with no caller outside a test — which is why it had never
 * been run end to end. This is that caller.
 *
 * ── AND IT LIVES OUTSIDE `services/agent/`, DELIBERATELY ──
 * `--fresh` calls `createRun` and `executeRun`, and `agent-readonly-guard.test`
 * forbids ANY module under `services/agent/` from naming an engine mutator —
 * the guard that protects the measured accuracy number (ADR-048, ADR-049). It
 * caught this file on its first run, and it was right to: an entry point that
 * drives the engine and then the Analyst is not an agent module. Moving it kept
 * the guard's claim literally true instead of carving an exception into it.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── IT WRITES A LEDGER, NOT A VERDICT ──
 * The output is what a run COST and how it BEHAVED: requests issued, retries,
 * tokens, per-turn latency, verdict distribution, grounding failures. It is not
 * an accuracy measurement — that needs the answer key and lives in
 * `tools/score` (validation-strategy §7), which does not score the Analyst yet.
 * Those are different claims and this file must not be read as making the
 * second one.
 *
 * ── `--dry-run` EXISTS BECAUSE THE QUOTA IS THE SCARCE THING ──
 * Triage is deterministic SQL and costs nothing (§3.1b), so the whole work list
 * and its worst-case request count are knowable BEFORE a single model call.
 * Checking the shape of a run against a metered daily allowance, rather than
 * discovering it halfway through, is the entire point.
 *
 * ── LATENCY IS MEASURED INSIDE THE PACER ──
 * The timing decorator wraps the provider client, so a throttle wait is never
 * counted as model latency. ADR-086 exists because a model bound was adopted
 * without being measured; the figure this prints is the one §8's 60 s bound has
 * to be checked against before any provider is adopted again.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { runMigrations } from '../db/migrate.js';
import { createPool, closePool, getPool } from '../db/pool.js';
import {
  ENGINE_DEFAULTS, AGENT_DEFAULTS, ANTHROPIC_COST_PER_MILLION,
  DEFAULT_ANTHROPIC_AGENT_MODEL,
} from '../config/defaults.js';
import { createRun, findRun } from '../repositories/runs.js';
import { executeRun } from '../services/run/orchestrator.js';
import { runPhaseA, type PhaseADeps } from '../services/agent/phase-a.js';
import { triageRun, type TriageBudget } from '../services/agent/triage.js';
import { createGeminiAgentClient } from '../services/agent/gemini-agent-client.js';
import {
  createAnthropicAgentClient, type AgentEffort,
} from '../services/agent/anthropic-agent-client.js';
import { createSpendGuard } from '../services/agent/spend-guard.js';
import { withRateLimit, RATE_LIMIT_DEFAULTS } from '../services/agent/rate-limiter.js';
import type { AgentLlmClient, CostModel } from '../services/agent/agent-client.js';
import type { RunConfig } from '../types/engine.js';

const FIX = new URL('../../../../data/fixtures/holdout/', import.meta.url).pathname;

/** Anthropic's published Opus 5 rates. Used ONLY for a labelled projection. */
const OPUS_5_RATES = { inputUsdPerMillion: 5, outputUsdPerMillion: 25 };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function intArg(name: string, fallback: number): number {
  const v = arg(name);
  return v === undefined ? fallback : Number.parseInt(v, 10);
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}

/** Times the PROVIDER call. Wrapped by the pacer, so waits are excluded. */
function timed(inner: AgentLlmClient, samples: number[]): AgentLlmClient {
  return {
    model: inner.model,
    async turn(request) {
      const t0 = Date.now();
      const result = await inner.turn(request);
      samples.push(Date.now() - t0);
      return result;
    },
  };
}

function readEnvFile(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(new URL('../../.env', import.meta.url).pathname, 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    );
  } catch { return {}; }
}

async function main(): Promise<void> {
  const fileEnv = readEnvFile();
  const get = (k: string): string | undefined => process.env[k] ?? fileEnv[k];

  const databaseUrl = get('DATABASE_URL');
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is not set');
  }
  // ADR-093: the model follows the provider. Reading GEMINI_AGENT_MODEL while
  // LLM_PROVIDER=anthropic sent a Gemini model id to the Anthropic API — caught
  // by `--dry-run` printing `gemini-3.7-flash` on a configured-for-Anthropic
  // run, which is exactly what a free dry run is for.
  const cliProvider = get('LLM_PROVIDER') ?? 'anthropic';
  const model = arg('model')
    ?? (cliProvider === 'anthropic'
      ? get('LLM_AGENT_MODEL') ?? DEFAULT_ANTHROPIC_AGENT_MODEL
      : get('GEMINI_AGENT_MODEL') ?? 'gemini-3.1-flash-lite');
  const dryRun = flag('dry-run');

  createPool({ databaseUrl, corsOrigins: [] } as never);
  await runMigrations(getPool());

  // ── the run under investigation ──
  let runId = arg('run');
  if (flag('fresh')) {
    const sources = {
      gateway: readFileSync(FIX + 'gateway_export.csv', 'utf8'),
      bank: readFileSync(FIX + 'bank_settlement.csv', 'utf8'),
      ledger: readFileSync(FIX + 'merchant_ledger.csv', 'utf8'),
    };
    const run = await createRun({
      label: 'analyst-baseline', datasetSeed: 90210,
      configSnapshot: { ...ENGINE_DEFAULTS, referenceDate: '1970-01-01', aliasCountAtStart: 0 },
    });
    process.stdout.write(`engine: executing a fresh holdout run ${run.id} …\n`);
    const out = await executeRun(run.id, sources, ENGINE_DEFAULTS);
    if (out.status !== 'completed') {
      throw new Error(`engine run did not complete: ${out.errorDetail ?? 'unknown'}`);
    }
    runId = run.id;
  }
  if (runId === undefined) throw new Error('pass --run <runId> or --fresh');

  const run = await findRun(runId);
  if (run === null) throw new Error(`no run ${runId}`);
  if (run.status !== 'completed') {
    throw new Error(`run ${runId} is ${run.status}, not completed`);
  }
  const config = run.configSnapshot as RunConfig;

  // ── the bounds, all overridable, all reported ──
  const maxInvestigations = intArg('investigations',
    Number(get('AGENT_MAX_INVESTIGATIONS_PER_RUN') ?? AGENT_DEFAULTS.maxInvestigationsPerRun));
  const maxCorroborations = intArg('corroborations',
    Number(get('AGENT_MAX_QUEUE_TRIAGES_PER_RUN') ?? AGENT_DEFAULTS.maxQueueTriagesPerRun));
  const maxRequests = intArg('requests',
    Number(get('AGENT_MAX_LLM_REQUESTS_PER_RUN') ?? AGENT_DEFAULTS.maxLlmRequestsPerRun));
  const rpm = intArg('rpm',
    Number(get('AGENT_MAX_REQUESTS_PER_MINUTE') ?? RATE_LIMIT_DEFAULTS.maxRequestsPerMinute));
  const tpm = intArg('tpm',
    Number(get('AGENT_MAX_TOKENS_PER_MINUTE') ?? RATE_LIMIT_DEFAULTS.maxTokensPerMinute));

  const triageBudget: TriageBudget = {
    maxInvestigations, maxQueueTriages: maxCorroborations,
  };
  const plan = await triageRun(runId, triageBudget);
  const worstCaseRequests =
    plan.investigate.length * AGENT_DEFAULTS.budget.maxSteps
    + plan.corroborate.length * AGENT_DEFAULTS.corroborate.maxSteps;

  process.stdout.write([
    '',
    `run                ${runId}`,
    `model              ${model}`,
    `triaged            ${plan.investigate.length} investigations `
      + `· ${plan.corroborate.length} corroborations `
      + `· ${plan.investigationsSkipped} eligible but over the cap`,
    `request budget     ${maxRequests}  (worst case for this list: ${worstCaseRequests})`,
    `pacing             ${rpm} req/min · ${tpm} tok/min`,
    `est. wall clock    >= ${(worstCaseRequests / rpm).toFixed(1)} min if every step is used`,
    '',
  ].join('\n'));

  if (dryRun) {
    process.stdout.write('--dry-run: no model calls made.\n');
    await closePool();
    return;
  }

  // ADR-093: the provider follows LLM_PROVIDER, and so does the key it demands.
  // Naming the missing variable matters — "GEMINI_API_KEY is not set" on a run
  // configured for Anthropic sends you looking in the wrong place.
  const provider = cliProvider;
  const keyVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
  const apiKey = get(keyVar);
  if (apiKey === undefined || apiKey === '') {
    throw new Error(`${keyVar} is not set (LLM_PROVIDER=${provider})`);
  }

  const latencies: number[] = [];
  const inner = provider === 'anthropic'
    ? createAnthropicAgentClient({
      apiKey, model, effort: (get('AGENT_EFFORT') ?? 'high') as AgentEffort })
    : createGeminiAgentClient({ apiKey, model });
  const paced = withRateLimit(
    timed(inner, latencies),
    { maxRequestsPerMinute: rpm, maxTokensPerMinute: tpm },
  );

  // ADR-094. The cap the CLI actually enforces, and it is announced before the
  // first call so a run that cannot afford itself is visible immediately.
  const maxCostUsd = Number(get('AGENT_MAX_COST_USD_PER_RUN') ?? '1.0');
  const costModel = provider === 'anthropic'
    ? ((ANTHROPIC_COST_PER_MILLION as Record<string, CostModel | undefined>)[model] ?? null)
    : null;
  const spendGuard = createSpendGuard({
    maxUsd: maxCostUsd, cost: costModel, maxOutputTokensPerTurn: 2048,
  });
  process.stdout.write(costModel === null
    ? 'spend guard  INERT — no published rate for this model, nothing to cap\n\n'
    : `spend guard  $${maxCostUsd.toFixed(2)} ceiling at `
      + `$${costModel.inputUsdPerMillion}/$${costModel.outputUsdPerMillion} per MTok, `
      + 'refused pre-flight on worst case\n\n');

  const deps: PhaseADeps = {
    client: paced.client,
    config,
    spendGuard,
    // The REAL rate when we are actually billed (ADR-093), null on the free
    // tier. A projection at another provider's rates is computed below and
    // LABELLED as such; it must never be reported as this run's cost.
    cost: provider === 'anthropic'
      ? ((ANTHROPIC_COST_PER_MILLION as Record<string, CostModel | undefined>)[model] ?? null)
      : null,
    maxLlmRequests: maxRequests,
    triageBudget,
    requestsIssued: () => paced.stats().requestsIssued,
  };

  const startedAt = Date.now();
  const result = await runPhaseA(runId, deps);
  const wallMs = Date.now() - startedAt;

  const stats = paced.stats();
  const sorted = [...latencies].sort((a, b) => a - b);
  const totalTokens = result.usage.tokensIn + result.usage.tokensOut;

  const ledger = {
    kind: 'analyst-baseline',
    runId,
    model,
    recordedAt: new Date().toISOString(),
    engine: {
      // Proof the Analyst changed nothing (ADR-048). Compared, not asserted.
      matchRatePct: (run.metrics as
        { matchRate?: { matchRatePct?: number } } | null)?.matchRate?.matchRatePct ?? null,
      matches: Number((await getPool().query(
        'SELECT count(*) AS n FROM matches WHERE run_id=$1', [runId])).rows[0].n),
      exceptions: Number((await getPool().query(
        'SELECT count(*) AS n FROM exceptions WHERE run_id=$1', [runId])).rows[0].n),
    },
    bounds: {
      maxInvestigations, maxCorroborations, maxRequests, rpm, tpm,
      investigationBudget: AGENT_DEFAULTS.budget,
      corroborationBudget: AGENT_DEFAULTS.corroborate,
    },
    triage: {
      investigate: plan.investigate.length,
      corroborate: plan.corroborate.length,
      investigationsSkipped: plan.investigationsSkipped,
      worstCaseRequests,
    },
    outcome: {
      investigated: result.investigated,
      corroborated: result.corroborated,
      verdicts: result.verdicts,
      corroborationVerdicts: result.corroborationVerdicts,
      groundingFailures: result.groundingFailures,
      corroborationGroundingFailures: result.corroborationGroundingFailures,
      budgetExhaustedCount: result.budgetExhaustedCount,
      skippedForBudget: result.skippedForBudget,
      auditEntries: result.auditEntries,
    },
    spend: {
      requestsSpent: result.requestsSpent,
      requestsIssued: stats.requestsIssued,
      retries: stats.retries,
      throttleWaitMs: stats.throttleWaitMs,
      backoffWaitMs: stats.backoffWaitMs,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      costUsd: result.costUsd,
      tokensPerInvestigation: result.investigated === 0
        ? null : Math.round(totalTokens / result.investigated),
      /**
       * NOT a cost. What these exact token counts WOULD cost at Anthropic's
       * published Opus 5 rates, so the swap can be budgeted from a measurement
       * instead of an estimate. A different model will not produce the same
       * token counts — this projects price, never behaviour.
       */
      projectedOpus5Usd: Number(
        ((result.usage.tokensIn * OPUS_5_RATES.inputUsdPerMillion
          + result.usage.tokensOut * OPUS_5_RATES.outputUsdPerMillion) / 1_000_000).toFixed(4),
      ),
    },
    latencyMs: {
      turns: latencies.length,
      min: sorted[0] ?? 0,
      median: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted.at(-1) ?? 0,
      /** §8 bounds a WHOLE investigation at 60 s. This is the check (ADR-086). */
      boundMs: AGENT_DEFAULTS.budget.maxWallMs,
      phaseWallMs: wallMs,
    },
  };

  const out = arg('out');
  if (out !== undefined) {
    writeFileSync(out, `${JSON.stringify(ledger, null, 2)}\n`);
    process.stdout.write(`ledger written to ${out}\n`);
  }
  process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
  await closePool();
}

main().catch(async (err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  await closePool().catch(() => { /* already closing */ });
  process.exitCode = 1;
});
