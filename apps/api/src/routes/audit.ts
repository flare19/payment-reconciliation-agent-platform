/**
 * Endpoint 14 — the whole-run audit trail.
 *
 * Thin: parse, validate, delegate, serialize (CLAUDE.md §4.3).
 *
 * Endpoint 22 (chain verification) lives on the runs router, beside the run it
 * verifies. This one is the readable timeline: sorted by `sequence_no`
 * ascending, which is chronological AND deterministic for the several hundred
 * entries a run writes inside a single transaction — `occurred_at` is not,
 * because they share a millisecond.
 */

import { Router } from 'express';
import { readRunTrail } from '../repositories/audit.js';
import * as runsRepo from '../repositories/runs.js';
import { handler, found, pageParams, stringParam, enumParam, uuidParam } from './helpers.js';
import { auditEntry, paginate } from './serialize.js';

export function auditRouter(): Router {
  const r = Router();

  r.get('/:runId/audit', handler(async (req, res) => {
    const runId = uuidParam(req, 'runId');
    found(await runsRepo.findRun(runId), 'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    const { page, pageSize, offset } = pageParams(req);

    const eventType = stringParam(req, 'eventType');
    // The four actor types are what the audit screen renders as four colours.
    // `llm` and `agent` must never appear on a MATCH_CONFIRMED_* event — that
    // separation is ADR-017 and ADR-048 made visible, and filtering by actor is
    // how a reader checks it.
    const actorType = enumParam(req, 'actorType', ['engine', 'human', 'llm', 'agent'] as const);

    const { entries, total } = await readRunTrail(runId, {
      ...(eventType === undefined ? {} : { eventType }),
      ...(actorType === undefined ? {} : { actorType }),
    }, pageSize, offset);

    res.json({
      entries: entries.map(auditEntry),
      pagination: paginate(page, pageSize, total),
    });
  }));

  return r;
}
