import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool, closePool, getPool } from '../../src/db/pool.js';
import { appendAuditEntry, readChain, verifyRunChain } from '../../src/repositories/audit.js';
import { GENESIS_HASH } from '../../src/services/audit/hash-chain.js';
import type { AuditEntryInput } from '../../src/repositories/audit.js';

/**
 * The hash chain against a real Postgres.
 *
 * The unit tests prove the arithmetic. These prove the thing that actually
 * threatens it: a jsonb round-trip. Postgres does not store object keys in
 * insertion order, so an entry hashed in JavaScript and verified after being read
 * back is the exact case where a naive serializer silently breaks every chain.
 */

const DB_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? null;
const RUN = '11111111-1111-1111-1111-111111111111';
const OTHER_RUN = '99999999-9999-9999-9999-999999999999';

function input(over: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    runId: RUN, eventType: 'RUN_STARTED', subjectType: 'run', subjectId: RUN,
    transactionId: null, actorType: 'engine', actorId: 'matching-engine@1.0.0',
    tier: null, ruleId: null, ruleVersion: null, decision: null, confidence: null,
    beforeState: null, afterState: null,
    reason: 'Run started.', details: {},
    ...over,
  };
}

describe('audit hash chain (integration)', { skip: DB_URL === null ? 'no TEST_DATABASE_URL' : false }, () => {
  before(async () => {
    createPool({ databaseUrl: DB_URL!, corsOrigins: [] } as never);
    await runMigrations(getPool());
    await getPool().query(`TRUNCATE runs, transactions, matches, match_members, exceptions,
      audit_log, learned_aliases, explanation_cache, score_reports,
      agent_investigations, agent_questions CASCADE`);
    for (const id of [RUN, OTHER_RUN]) {
      await getPool().query(
        `INSERT INTO runs (id,label,status,config_snapshot) VALUES ($1,'t','pending','{}')`, [id]);
    }
  });
  after(async () => { await closePool(); });

  test('the first entry chains from genesis', async () => {
    const e = await appendAuditEntry(input());
    assert.equal(e.prevHash, GENESIS_HASH);
    assert.match(e.entryHash, /^[0-9a-f]{64}$/);
    assert.ok(e.sequenceNo > 0);
  });

  test('each entry chains from the previous one', async () => {
    const a = await appendAuditEntry(input({ reason: 'second' }));
    const b = await appendAuditEntry(input({ reason: 'third' }));
    assert.equal(b.prevHash, a.entryHash);
  });

  test('THE JSONB ROUND-TRIP: a chain written in JS verifies after a DB read', async () => {
    // The case that breaks a naive serializer. Postgres jsonb reorders keys, so
    // these payloads come back with a different key order than they went in with.
    await appendAuditEntry(input({
      reason: 'nested payload',
      details: { zebra: 1, alpha: { yankee: [3, 2, 1], bravo: 'x' }, mike: null },
      afterState: { matchId: 'm1', scoreBreakdown: { date: 0.2, anchor: 0.3, amount: 0.35 } },
    }));
    await appendAuditEntry(input({
      reason: 'unicode and money ₹1,23,456.50 ✓',
      details: { 'key with spaces': 'v', 'ключ': 'значение', nested: { b: [1, { d: 4, c: 3 }] } },
    }));
    const r = await verifyRunChain(RUN);
    assert.equal(r.valid, true, `chain broke after a jsonb round-trip: ${JSON.stringify(r)}`);
  });

  test('key order really does change across the round-trip', async () => {
    // Proves the test above is exercising something real rather than passing by
    // luck — if jsonb preserved insertion order, canonical JSON would be moot.
    const { rows } = await getPool().query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE reason = 'nested payload'`);
    const readBack = Object.keys(rows[0]!.details);
    assert.notDeepEqual(readBack, ['zebra', 'alpha', 'mike'],
      'jsonb returned insertion order; this test needs rethinking');
    assert.deepEqual([...readBack].sort(), ['alpha', 'mike', 'zebra']);
  });

  test('the whole run verifies, and reports its head', async () => {
    const r = await verifyRunChain(RUN);
    const chain = await readChain(RUN);
    assert.equal(r.valid, true);
    assert.equal(r.entriesChecked, chain.length);
    assert.equal(r.chainHead, chain[chain.length - 1]!.entryHash);
  });

  test('chains are PER RUN and do not interfere', async () => {
    // Entries for a second run start their own chain from genesis. Verifying one
    // run must not see the other's entries as a break.
    const first = await appendAuditEntry(input({ runId: OTHER_RUN, subjectId: OTHER_RUN }));
    assert.equal(first.prevHash, GENESIS_HASH);
    assert.equal((await verifyRunChain(OTHER_RUN)).valid, true);
    assert.equal((await verifyRunChain(RUN)).valid, true);
  });

  test('run-less alias-admin entries form their own chain', async () => {
    const e = await appendAuditEntry(input({
      runId: null, eventType: 'ALIAS_CREATED', subjectType: 'alias',
      subjectId: '33333333-3333-3333-3333-333333333333',
      actorType: 'human', actorId: 'tejas', reason: 'AMZN is Amazon Retail.',
    }));
    assert.equal(e.prevHash, GENESIS_HASH);
    assert.equal((await verifyRunChain(null)).valid, true);
  });

  test('TAMPERING IS DETECTED even with the append-only trigger dropped', async () => {
    // The scenario ADR-042 exists for. The trigger stops tampering through the
    // application; anyone who can drop it can rewrite history, and only the chain
    // shows that they did.
    const client = await getPool().connect();
    try {
      await client.query('ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_immutable');
      // sequence_no arrives as a NUMBER, not a string: the int8 type parser in
      // db/pool.ts converts it (ADR-059). Typing it as a string here silently
      // compared '21' to 21.
      const { rows } = await client.query<{ sequence_no: number }>(
        `SELECT sequence_no FROM audit_log WHERE run_id = $1 ORDER BY sequence_no OFFSET 1 LIMIT 1`,
        [RUN]);
      const target = rows[0]!.sequence_no;
      await client.query(
        `UPDATE audit_log SET reason = 'a reason nobody gave' WHERE sequence_no = $1`, [target]);

      const r = await verifyRunChain(RUN);
      assert.equal(r.valid, false, 'a silently edited row must not verify');
      assert.equal(r.divergenceKind, 'entry_altered');
      assert.equal(r.firstDivergenceSequenceNo, target);

      // Restore so later assertions run against a clean chain.
      await client.query(
        `UPDATE audit_log SET reason = 'second' WHERE sequence_no = $1`, [target]);
    } finally {
      await client.query('ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_immutable');
      client.release();
    }
    assert.equal((await verifyRunChain(RUN)).valid, true, 'restored chain verifies again');
  });

  test('a deleted row is detected as a broken chain, not an altered entry', async () => {
    const client = await getPool().connect();
    let deleted: { sequence_no: number } | undefined;
    try {
      await client.query('ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_immutable');
      const { rows } = await client.query<{ sequence_no: number }>(
        `SELECT sequence_no FROM audit_log WHERE run_id = $1 ORDER BY sequence_no OFFSET 1 LIMIT 1`,
        [RUN]);
      deleted = rows[0]!;
      await client.query(`DELETE FROM audit_log WHERE sequence_no = $1`, [deleted.sequence_no]);
      const r = await verifyRunChain(RUN);
      assert.equal(r.valid, false);
      assert.equal(r.divergenceKind, 'chain_broken',
        'a hole is a different claim from an edit, and is reported as one');
    } finally {
      await client.query('ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_immutable');
      client.release();
    }
  });

  test('A CALLER-SUPPLIED CLIENT OUTSIDE A TRANSACTION IS REFUSED', async () => {
    // The lock is `pg_advisory_xact_lock`, so it lives exactly as long as the
    // transaction does. Handed a client in autocommit, the lock is released by the
    // statement that took it — before the head is even read — and the append runs
    // completely unprotected. Refusing is the only safe answer: an audit write that
    // silently drops its own concurrency guarantee is worse than one that fails.
    const c = await getPool().connect();
    try {
      await assert.rejects(
        () => appendAuditEntry(input({ reason: 'unprotected' }), c as never),
        /transaction/i,
        'an append on a non-transactional client must throw, not proceed unprotected',
      );
    } finally { c.release(); }
  });

  test('CONCURRENT APPENDS ON BARE POOLED CLIENTS CANNOT CORRUPT THE CHAIN', async () => {
    // The reproduction from the units 9-10 audit (issue #16). Before the fix these
    // twelve appends all succeeded, four of them claiming one predecessor and two
    // another, and verifyRunChain then reported `chain_broken` on a log nobody had
    // tampered with — the worst false positive available to a tamper-evidence
    // mechanism, and produced by the writer itself.
    const bareRun = '55555555-5555-5555-5555-555555555555';
    await getPool().query(
      `INSERT INTO runs (id,label,status,config_snapshot) VALUES ($1,'bare','pending','{}')
       ON CONFLICT DO NOTHING`, [bareRun]);

    const settled = await Promise.allSettled(Array.from({ length: 12 }, async (_, i) => {
      const c = await getPool().connect();
      try { await appendAuditEntry(input({ runId: bareRun, subjectId: bareRun, reason: `bare ${i}` }), c as never); }
      finally { c.release(); }
    }));

    assert.equal(settled.filter((s) => s.status === 'rejected').length, 12,
      'every unprotected append must be refused');
    const { rows } = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_log WHERE run_id = $1', [bareRun]);
    assert.equal(rows[0]!.n, 0, 'a refused append must write nothing');
    assert.equal((await verifyRunChain(bareRun)).valid, true);
  });

  test('the append path itself cannot break the chain under concurrency', async () => {
    // schema.md §9.0 assumes a single writer. The advisory lock makes that
    // ENFORCED rather than assumed: without it two appends read the same head and
    // produce two entries claiming the same predecessor — a chain that verifies as
    // broken because of the writer, which is the worst false positive available
    // for a tamper-evidence mechanism.
    await getPool().query(`DELETE FROM runs WHERE id = $1`, ['44444444-4444-4444-4444-444444444444'])
      .catch(() => undefined);
    const busyRun = '44444444-4444-4444-4444-444444444444';
    await getPool().query(
      `INSERT INTO runs (id,label,status,config_snapshot) VALUES ($1,'busy','pending','{}')
       ON CONFLICT DO NOTHING`, [busyRun]);

    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      appendAuditEntry(input({ runId: busyRun, subjectId: busyRun, reason: `concurrent ${i}` }))));

    const r = await verifyRunChain(busyRun);
    assert.equal(r.valid, true, `concurrent appends produced a broken chain: ${JSON.stringify(r)}`);
    assert.equal(r.entriesChecked, 12);
  });
});
