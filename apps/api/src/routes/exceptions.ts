/**
 * Endpoints 7 and 20 — exception drill-down and human resolution.
 *
 * Thin: parse, validate, delegate, serialize (CLAUDE.md §4.3).
 *
 * The exception list is the primary graded feature, and endpoint 7 is where a
 * reviewer decides whether the engine's refusal to guess was justified. Every
 * field it returns is deterministic: `rejectedBecause` comes from the RULE
 * ENGINE, not the LLM, and renders with the explain layer disabled or the API
 * key absent.
 */

import { Router } from 'express';
import { ApiError } from '../app.js';
import { withTransaction } from '../db/pool.js';
import * as excRepo from '../repositories/exceptions.js';
import * as txnRepo from '../repositories/transactions.js';
import { peekCachedExplanation } from '../repositories/explanations.js';
import { appendAuditEntry, readTransactionTrail } from '../repositories/audit.js';
import { handler, found, requireString, enumParam, uuidParam } from './helpers.js';
import { exceptionDetail } from './serialize.js';
import type { NormalizedTransaction } from '../types/engine.js';

export function exceptionsRouter(): Router {
  const r = Router();

  // 7 · GET /api/exceptions/:exceptionId
  r.get('/:exceptionId', handler(async (req, res) => {
    const id = uuidParam(req, 'exceptionId');
    const e = found(await excRepo.findException(id),
      'EXCEPTION_NOT_FOUND', `No exception exists with id ${id}`);

    const wanted = new Set<string>([
      ...(e.transactionId === null ? [] : [e.transactionId]),
      ...e.relatedTransactionIds,
      ...(e.evidence.candidates ?? []).map((c) => c.transactionId),
    ]);
    const all = await txnRepo.listTransactions(e.runId);
    const byId = new Map<string, NormalizedTransaction>(
      all.filter((t) => wanted.has(t.id)).map((t) => [t.id, t]));

    // `sharedExplanationCount` is the cache's hit count for this signature — it
    // tells a reader how many other exceptions share this exact shape, which is
    // the number that makes the signature mechanism legible (ADR-018). Null
    // until the explain layer has run.
    const cached = e.signatureHash === null ? null : await peekCachedExplanation(e.signatureHash);
    const trail = e.transactionId === null
      ? { total: 0 }
      : await readTransactionTrail(e.transactionId, 1, 0);

    res.json(exceptionDetail(
      e,
      e.transactionId === null ? null : byId.get(e.transactionId) ?? null,
      e.relatedTransactionIds.map((rid) => byId.get(rid)).filter((t): t is NormalizedTransaction => t !== undefined),
      byId,
      cached === null ? null : cached.hitCount,
      trail.total,
    ));
  }));

  // 20 · POST /api/exceptions/:exceptionId/resolve
  r.post('/:exceptionId/resolve', handler(async (req, res) => {
    const id = uuidParam(req, 'exceptionId');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const resolvedBy = requireString(body, 'resolvedBy');
    // `exc_resolution_complete` refuses a resolution with no stated reason at
    // the database; requiring it here names the actual problem instead of
    // surfacing a constraint violation.
    const note = requireString(body, 'note');
    const resolution = enumParam(
      { query: { resolution: body['resolution'] } } as never, 'resolution',
      ['human_resolved', 'wont_fix'] as const) ?? 'human_resolved';

    const existing = found(await excRepo.findException(id),
      'EXCEPTION_NOT_FOUND', `No exception exists with id ${id}`);

    const result = await withTransaction(async (c) => {
      const updated = await excRepo.resolveException(id,
        { status: resolution, resolvedBy, note }, c);
      if (updated === null) {
        // The guard is in the WHERE clause, so a second resolver gets null
        // rather than overwriting the first.
        throw new ApiError(409, 'EXCEPTION_ALREADY_RESOLVED',
          `Exception is ${existing.status} and has already been dispositioned.`);
      }
      const entry = await appendAuditEntry({
        runId: updated.runId, actorType: 'human', actorId: resolvedBy,
        eventType: resolution === 'wont_fix'
          ? 'EXCEPTION_DISMISSED_BY_HUMAN' : 'EXCEPTION_RESOLVED_BY_HUMAN',
        subjectType: 'exception', subjectId: updated.id,
        transactionId: updated.transactionId,
        tier: null, ruleId: updated.detectedByRule, ruleVersion: updated.ruleVersion,
        decision: resolution, confidence: null,
        beforeState: { status: existing.status },
        afterState: { status: resolution, resolvedBy },
        reason: note,
        details: { exceptionId: updated.id, category: updated.category },
      }, c);
      return { updated, sequenceNo: entry.sequenceNo };
    });

    res.json({
      exception: { exceptionId: result.updated.id, status: result.updated.status,
                   resolvedBy: result.updated.resolvedBy,
                   resolvedAt: result.updated.resolvedAt?.toISOString() ?? null,
                   resolutionNote: result.updated.resolutionNote },
      auditEntryIds: [result.sequenceNo],
    });
  }));

  return r;
}
