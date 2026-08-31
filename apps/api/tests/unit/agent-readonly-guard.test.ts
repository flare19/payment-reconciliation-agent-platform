import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripComments } from './truth-leak-guard.test.js';

/**
 * ADR-049 / ADR-051 — Phase A proposes; humans dispose.
 *
 * `CLAUDE.md` §4 rule 11: "The agent's tool registry contains no mutating tool,
 * ever. If you find yourself adding a write tool, the design has gone wrong."
 *
 * The RUNTIME guarantee is `withReadOnlyTransaction` — Postgres refuses the
 * write, and `tool-registry.test.ts` asserts it throws SQLSTATE 25006. This file
 * is the STRUCTURAL half, and it exists because the runtime guarantee has one
 * gap: a tool that opened its own pool connection would escape the read-only
 * transaction entirely, and every test would still pass.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * TWO DIFFERENT RULES, AND THE FIRST VERSION OF THIS FILE CONFLATED THEM.
 *
 * It asserted "no module under services/agent writes", which was true while the
 * directory held only the registry, the gate and the loop — and WRONG the moment
 * A4 landed, because Phase A must persist its verdicts (§3 A4) and its audit
 * trail (ADR-052). The guard fired on correct code.
 *
 * What ADR-049/051 actually says is narrower and sharper:
 *
 *   1. THE TOOL PATH writes NOTHING. `tool-registry.ts` may not reach the pool,
 *      open a writable transaction, or call any mutating repository function.
 *      This is the registry the model drives, so it is the surface an agent
 *      could turn against the database.
 *   2. NO AGENT MODULE may write to an ENGINE table. Phase A records its own
 *      account of its own work — `agent_investigations`, `agent_questions`,
 *      `audit_log` — and may never touch `matches`, `exceptions`,
 *      `transactions`, `learned_aliases` or `runs`. That is ADR-048's line:
 *      the agent proposes, humans dispose through endpoints 16/20/21.
 *
 * Rule 2 is the one that actually protects the measured accuracy number, and the
 * original over-broad rule would have been RELAXED to let A4 through — losing
 * it. Splitting them keeps the strong half strong.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Same reasoning as `truth-leak-guard` and `single-scorer-guard`: a comment
 * saying "this layer never writes" is a hope; a failing test is a property.
 */

const SRC = new URL('../../src/', import.meta.url).pathname;
const AGENT = join(SRC, 'services', 'agent');

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

async function agentSources(): Promise<{ rel: string; code: string }[]> {
  const files = await walk(AGENT);
  return Promise.all(files.map(async (f) => ({
    rel: f.replace(SRC, ''),
    code: stripComments(await readFile(f, 'utf8')),
  })));
}

describe('the agent layer cannot write (ADR-049, ADR-051)', () => {
  test('no module under services/agent contains SQL DML', async () => {
    // Catches the direct route: someone writes a query string in an agent module
    // rather than going through a repository at all.
    const dml = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE)\b/i;
    const offenders: string[] = [];
    for (const { rel, code } of await agentSources()) {
      if (dml.test(code)) offenders.push(rel);
    }
    assert.deepEqual(offenders, [],
      'Phase A reads the engine\'s output and never writes to it. All SQL lives in repositories/.');
  });

  /**
   * RULE 2 — no agent module may write to an ENGINE table.
   *
   * This is the one that protects the measured accuracy number. Phase A records
   * its own work and never edits the engine's output (ADR-048).
   */
  const ENGINE_MUTATORS = [
    'insertTransactions', 'markDuplicates', 'setCounterpartyKeys',
    'insertMatch', 'insertMatches', 'reviewMatch',
    'insertExceptions', 'setExplanation', 'resolveException',
    'upsertAlias', 'revokeAlias', 'recordAliasApplications',
    'putExplanation', 'getCachedExplanation',
    'createRun', 'setRunStatus', 'recordIngestion', 'setRunMetrics', 'finishRun',
    'reapInterruptedRuns', 'insertScoreReport',
  ];

  /** The writes Phase A is ALLOWED: its own account of its own work. */
  const PERMITTED_AGENT_WRITES = [
    'startInvestigation', 'concludeInvestigation', 'failInvestigation',
    'recordDisposition', 'recordQuestion', 'appendAuditEntry',
  ];

  test('RULE 2: no agent module writes to an ENGINE table', async () => {
    const offenders: string[] = [];
    for (const { rel, code } of await agentSources()) {
      for (const fn of ENGINE_MUTATORS) {
        // `getCachedExplanation` is in the list because it UPDATEs a hit counter
        // — a read-looking name that writes is exactly the trap here.
        if (new RegExp(`\\b(?:\\w+\\.)?${fn}\\s*\\(`).test(code)) {
          offenders.push(`${rel}: ${fn}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      'Phase A proposes; humans dispose through endpoints 16/20/21 (ADR-048, ADR-049).');
  });

  test('RULE 1: the TOOL PATH writes nothing and never reaches the pool', async () => {
    // THE GAP THE RUNTIME GUARANTEE HAS. `withReadOnlyTransaction` only
    // constrains queries issued on the client it yields. A tool calling
    // `getPool().query(…)` — or a repository function without passing the client
    // — runs in autocommit with full write access, and every existing test would
    // still pass because the tools it tests happen not to write.
    //
    // Scoped to the registry: this is the surface the MODEL drives.
    const registry = stripComments(await readFile(join(AGENT, 'tool-registry.ts'), 'utf8'));
    const offenders: string[] = [];
    if (/\bgetPool\s*\(/.test(registry)) offenders.push('getPool()');
    if (/\bwithTransaction\s*\(/.test(registry)) offenders.push('withTransaction()');
    if (/\.connect\s*\(\s*\)/.test(registry)) offenders.push('pool.connect()');
    for (const fn of [...ENGINE_MUTATORS, ...PERMITTED_AGENT_WRITES]) {
      if (new RegExp(`\\b(?:\\w+\\.)?${fn}\\s*\\(`).test(registry)) {
        offenders.push(fn);
      }
    }
    assert.deepEqual(offenders, [],
      'The tool registry must obtain its client from withReadOnlyTransaction and write '
      + 'NOTHING — not even an agent table. It is the surface the model drives.');
  });

  test('Phase A\'s writes are exactly its OWN tables, and it says which', async () => {
    // Not a relaxation of rule 2 — a statement of the narrow exception, so that
    // widening it later is a visible edit to this list rather than a quiet one.
    const phase = stripComments(await readFile(join(AGENT, 'phase-a.ts'), 'utf8'));
    const used = PERMITTED_AGENT_WRITES.filter(
      (fn) => new RegExp(`\\b(?:\\w+\\.)?${fn}\\s*\\(`).test(phase));
    assert.ok(used.includes('startInvestigation'));
    assert.ok(used.includes('concludeInvestigation'));
    assert.ok(used.includes('appendAuditEntry'));
    for (const fn of ENGINE_MUTATORS) {
      assert.doesNotMatch(phase, new RegExp(`\\b(?:\\w+\\.)?${fn}\\s*\\(`),
        `phase-a.ts calls ${fn}, which writes engine output`);
    }
  });

  test('every repository call in the tool registry passes the read-only client', async () => {
    // A repository function called WITHOUT the client falls back to `getPool()`
    // internally and leaves the transaction — the same escape as above, one layer
    // down and much easier to write by accident.
    const code = stripComments(await readFile(join(AGENT, 'tool-registry.ts'), 'utf8'));
    const calls = [...code.matchAll(/\b(?:txnRepo|excRepo|auditRepo|aliasRepo|runsRepo)\.(\w+)\(([^;]*?)\)(?=[,;)\s])/gs)];
    assert.ok(calls.length >= 8, `expected repository calls to inspect, found ${calls.length}`);
    const offenders: string[] = [];
    for (const [whole, fn] of calls) {
      // Every call must mention the client binding somewhere in its arguments.
      if (!/\bc\b/.test(whole.slice(whole.indexOf('(')))) offenders.push(String(fn));
    }
    assert.deepEqual(offenders, [],
      'a repository call without the read-only client silently runs on the pool instead');
  });

  test('the guards would FIRE on the code they exist to reject', () => {
    // A guard nobody has watched fail is indistinguishable from one that cannot
    // (the Day 9 scorer lesson, and the fifth "test whose name claims more than
    // its assertion" in what-broke.md).
    const dml = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE)\b/i;
    assert.match('await c.query(`INSERT INTO learned_aliases (a) VALUES (1)`)', dml);
    assert.match('UPDATE exceptions SET status = 1', dml);
    assert.match('DELETE FROM matches', dml);
    assert.doesNotMatch('SELECT * FROM transactions', dml);

    assert.match('await aliasRepo.upsertAlias(x)', /\b(?:\w+\.)?upsertAlias\s*\(/);
    assert.match('upsertAlias(x)', /\b(?:\w+\.)?upsertAlias\s*\(/);

    assert.match('const { rows } = await getPool().query(sql)', /\bgetPool\s*\(/);
    assert.match('await pool.connect()', /\.connect\s*\(\s*\)/);
  });
});
