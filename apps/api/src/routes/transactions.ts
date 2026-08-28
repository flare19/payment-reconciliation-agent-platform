/**
 * Endpoints 12, 13 — the record inspector and its audit trail.
 *
 * Thin: parse, validate, delegate, serialize (CLAUDE.md §4.3).
 *
 * `rawPayload` is the POINT of endpoint 12, not a debugging extra. Ingestion is
 * lossless and opinion-free precisely so a panelist can be shown the raw source
 * row beside what the parser made of it; an inspector that shows only normalized
 * fields asks the viewer to trust the parser, which is the one thing this screen
 * exists to avoid.
 */

import { Router } from 'express';
import * as txnRepo from '../repositories/transactions.js';
import * as matchRepo from '../repositories/matches.js';
import * as excRepo from '../repositories/exceptions.js';
import { readTransactionTrail } from '../repositories/audit.js';
import { handler, found, pageParams, pathParam } from './helpers.js';
import { transactionDetail, auditEntry, paginate } from './serialize.js';

export function transactionsRouter(): Router {
  const r = Router();

  // 12 · GET /api/transactions/:transactionId
  r.get('/:transactionId', handler(async (req, res) => {
    const id = pathParam(req, 'transactionId');
    const t = found(await txnRepo.findTransaction(id),
      'TRANSACTION_NOT_FOUND', `No transaction exists with id ${id}`);

    // `membership` and `exceptionId` are the two navigation links. On a
    // COMPLETED run exactly one is non-null for any reconcilable, non-duplicate
    // row — both null there means a record was neither matched nor classified,
    // which is a bug worth surfacing rather than rendering as an empty panel.
    const matches = await matchRepo.findMatchesForTransaction(id);
    const live = matches.find((m) => m.status !== 'human_rejected') ?? null;
    const exceptions = await excRepo.listExceptionsForTransaction(id);
    const own = exceptions.find((e) => e.transactionId === id) ?? null;

    res.json(transactionDetail(t, {
      membership: live === null ? null : {
        matchId: live.id,
        role: live.members.find((m) => m.transactionId === id)?.role ?? t.sourceSystem,
        matchStatus: live.status,
      },
      exceptionId: own?.id ?? null,
    }));
  }));

  // 13 · GET /api/transactions/:transactionId/audit
  r.get('/:transactionId/audit', handler(async (req, res) => {
    const id = pathParam(req, 'transactionId');
    found(await txnRepo.findTransaction(id),
      'TRANSACTION_NOT_FOUND', `No transaction exists with id ${id}`);
    const { page, pageSize, offset } = pageParams(req);
    const { entries, total } = await readTransactionTrail(id, pageSize, offset);
    res.json({
      entries: entries.map(auditEntry),
      pagination: paginate(page, pageSize, total),
    });
  }));

  return r;
}
