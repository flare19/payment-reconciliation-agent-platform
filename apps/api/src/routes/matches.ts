/**
 * Endpoints 10, 11, 21 — human verdicts on matches.
 *
 * Thin: parse, validate, delegate, serialize (CLAUDE.md §4.3).
 *
 * Every handler here writes an audit entry with `actor_type = 'human'`. That
 * separation is ADR-017 and ADR-043 made visible: the audit screen renders four
 * actor colours, and a human's assertion must never be indistinguishable from
 * the engine's inference. A manual match (endpoint 21) is `tier: 'manual'`,
 * which the match DTO then excludes from `countsTowardEngineMatchRate` — a
 * human fix is a fix, not evidence the engine worked.
 */

import { Router } from 'express';
import { ApiError } from '../app.js';
import type { TxClient } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import * as matchRepo from '../repositories/matches.js';
import * as aliasRepo from '../repositories/aliases.js';
import * as txnRepo from '../repositories/transactions.js';
import * as runsRepo from '../repositories/runs.js';
import { appendAuditEntry } from '../repositories/audit.js';
import { normalizeCounterparty } from '../services/ingestion/normalize.js';
import { handler, found, requireString, optionalString, pathParam } from './helpers.js';
import { matchSummary, aliasDto } from './serialize.js';
import type { AliasType, AliasScope, MemberRole } from '../types/domain.js';

const HUMAN = { actorType: 'human' } as const;
const blank = {
  transactionId: null, tier: null, ruleId: null, ruleVersion: null,
  decision: null, confidence: null, beforeState: null, afterState: null,
} as const;


/**
 * Teach the aliases a reviewer attached to an approval, refusing any that would
 * silently replace an active rule (ADR-131).
 *
 * -------------------------------------------------------------------------
 * `ALIAS_CONFLICT_UNCONFIRMED` WAS DECLARED IN `ERROR_CODES`, PROMISED BY
 * `api-contract.md`, HANDLED BY `ReviewCard`, AND THROWN NOWHERE. Proposing a
 * different canonical for an already-active key returned 200 and superseded the
 * correct rule without a word. §6.3's supersede-with-penalty underneath is
 * right and unchanged — one misclick costs one extra review rather than
 * poisoning auto-resolution — but a reviewer has to be told they are about to
 * spend it.
 * -------------------------------------------------------------------------
 *
 * THIS RUNS AFTER THE APPROVAL HAS COMMITTED, deliberately. The interface
 * promises *"The match was approved. Only the alias was held back — a judgement
 * about this match is never discarded over a disagreement about a general
 * rule."* Throwing inside the approval transaction would roll the approval back
 * and make that sentence false.
 */
async function teachAliases(
  raw: unknown, match: matchRepo.Match, reviewedBy: string, c: TxClient,
): Promise<{ created: Record<string, unknown>[]; entries: number[] }> {
  // Teaching an alias is optional and is the whole point of the loop: the
  // reviewer's correction becomes reusable. Conflicts supersede with a
  // penalty (§6.3) rather than overwriting, so one misclick costs one extra
  // review rather than permanently poisoning auto-resolution.
  const created: Record<string, unknown>[] = [];
  const entries: number[] = [];
  for (const proposal of aliasProposals(raw)) {
    const normalizedValue = normalizeCounterparty(proposal.rawValue) ?? proposal.rawValue;
    const canonicalValue =
      normalizeCounterparty(proposal.canonicalValue) ?? proposal.canonicalValue;

    // THE INTERLOCK. Refuse only a genuine disagreement: an active rule for the
    // same key pointing somewhere ELSE. Re-asserting the same mapping is a
    // confirmation, not a conflict, and §6.3 counts it as one.
    const active = await aliasRepo.findActiveAlias(
      proposal.aliasType, normalizedValue, proposal.scopeSource, c);
    if (active !== null && active.canonicalValue !== canonicalValue
      && !proposal.confirmConflict) {
      throw new ApiError(409, 'ALIAS_CONFLICT_UNCONFIRMED',
        `'${active.rawValue}' already resolves to '${active.canonicalValue}', taught by `
        + `${active.createdBy}. Replacing it supersedes that rule and marks the key contested, `
        + 'so neither mapping resolves automatically until a human confirms one twice (§6.3).',
        {
          existingAliasId: active.id,
          existingCanonicalValue: active.canonicalValue,
          proposedCanonicalValue: canonicalValue,
          normalizedValue,
          confirmWith: { confirmConflict: true },
        });
    }

    const upsert = await aliasRepo.upsertAlias({
      aliasType: proposal.aliasType, scopeSource: proposal.scopeSource,
      rawValue: proposal.rawValue,
      normalizedValue,
      canonicalValue,
      createdBy: reviewedBy, createdFromMatchId: match.id,
    }, c);
    created.push(aliasDto(upsert.alias));
    const e = await appendAuditEntry({
      ...HUMAN, ...blank, runId: match.runId, actorId: reviewedBy,
      eventType: upsert.outcome === 'reaffirmed' ? 'ALIAS_REAFFIRMED'
        : upsert.outcome === 'superseded' ? 'ALIAS_CONFLICT_SUPERSEDED' : 'ALIAS_CREATED',
      subjectType: 'alias', subjectId: upsert.alias.id,
      reason:
        `${reviewedBy} asserted '${upsert.alias.rawValue}' resolves to ` +
        `'${upsert.alias.canonicalValue}' while approving match ${match.id}`,
      beforeState: upsert.outcome === 'superseded' ? { aliasId: upsert.previous.id,
        canonicalValue: upsert.previous.canonicalValue } : null,
      afterState: { aliasId: upsert.alias.id, canonicalValue: upsert.alias.canonicalValue,
        eligibleForAliasTier: upsert.alias.eligibleForAliasTier },
      details: { outcome: upsert.outcome, matchId: match.id },
    }, c);
    entries.push(e.sequenceNo);
  }
  return { created, entries };
}

export function matchesRouter(): Router {
  const r = Router();

  // 10 · POST /api/matches/:matchId/approve
  r.post('/:matchId/approve', handler(async (req, res) => {
    const matchId = pathParam(req, 'matchId');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reviewedBy = requireString(body, 'reviewedBy');
    const note = optionalString(body, 'note');

    const existing = found(await matchRepo.findMatch(matchId),
      'MATCH_NOT_FOUND', `No match exists with id ${matchId}`);

    // api-contract §0: approve is IDEMPOTENT. Re-approving an already-approved
    // match returns 200 with the existing state, not an error — a reviewer who
    // double-clicks should not see a failure for an action that already
    // succeeded.
    /**
     * IDEMPOTENT, BUT NOT INERT (ADR-131). Re-approving an already-approved
     * match must still process any `aliasProposals` the retry carries —
     * otherwise the conflict interlock below is a dead end: it approves the
     * match, refuses the alias, and the reviewer's "Replace the Existing Rule"
     * retry arrives at an already-`human_confirmed` match, short-circuits here,
     * and reports `aliasesCreated: []` as though it had succeeded. The alias
     * could never be taught on the second attempt, which is the only attempt
     * that was ever going to teach it.
     */
    if (existing.status === 'human_confirmed') {
      const created = await withTransaction(
        (c) => teachAliases(body['aliasProposals'], existing, reviewedBy, c));
      const byId = await membersById(existing);
      res.json({
        match: matchSummary(existing, byId),
        aliasesCreated: created.created,
        auditEntryIds: created.entries,
      });
      return;
    }
    if (existing.status !== 'pending_review') {
      throw new ApiError(409, 'MATCH_NOT_REVIEWABLE',
        `Match is ${existing.status}; only a pending_review match can be approved.`);
    }

    const result = await withTransaction(async (c) => {
      const match = await matchRepo.reviewMatch(matchId,
        { status: 'human_confirmed', reviewedBy, note }, c);
      if (match === null) {
        // Lost a race with another reviewer between the read above and here.
        throw new ApiError(409, 'MATCH_NOT_REVIEWABLE',
          'Match stopped being reviewable while this request was in flight.');
      }
      const entries: number[] = [];
      const approved = await appendAuditEntry({
        ...HUMAN, ...blank, runId: match.runId, actorId: reviewedBy,
        eventType: 'MATCH_APPROVED_BY_HUMAN', subjectType: 'match', subjectId: match.id,
        tier: match.tier, ruleId: match.ruleId, ruleVersion: match.ruleVersion,
        decision: 'human_confirmed', confidence: match.confidence,
        reason: note ?? `approved by ${reviewedBy}`,
        beforeState: { status: existing.status }, afterState: { status: 'human_confirmed' },
        details: { matchId: match.id, note },
      }, c);
      entries.push(approved.sequenceNo);

      return { match, entries };
    });

    /**
     * A SECOND TRANSACTION, SO THE APPROVAL SURVIVES A REFUSED ALIAS (ADR-131).
     *
     * `teachAliases` throws `409 ALIAS_CONFLICT_UNCONFIRMED` on a proposal that
     * would replace an active rule. Inside the approval transaction that throw
     * rolls the approval back — measured, and it left the match `pending_review`
     * — which makes the interface's promise false: *"The match was approved.
     * Only the alias was held back — a judgement about this match is never
     * discarded over a disagreement about a general rule."*
     */
    const alias = await withTransaction(
      (c) => teachAliases(body['aliasProposals'], result.match, reviewedBy, c));

    const byId = await membersById(result.match);
    res.json({
      match: matchSummary(result.match, byId),
      aliasesCreated: alias.created,
      auditEntryIds: [...result.entries, ...alias.entries],
    });
  }));

  // 11 · POST /api/matches/:matchId/reject
  r.post('/:matchId/reject', handler(async (req, res) => {
    const matchId = pathParam(req, 'matchId');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reviewedBy = requireString(body, 'reviewedBy');
    // A rejection with no stated reason is a hole in the audit trail. The
    // contract requires it and so does this.
    const reason = requireString(body, 'reason');

    const existing = found(await matchRepo.findMatch(matchId),
      'MATCH_NOT_FOUND', `No match exists with id ${matchId}`);
    if (existing.status !== 'pending_review') {
      throw new ApiError(409, 'MATCH_NOT_REVIEWABLE',
        `Match is ${existing.status}; only a pending_review match can be rejected.`);
    }

    const result = await withTransaction(async (c) => {
      const match = await matchRepo.reviewMatch(matchId,
        { status: 'human_rejected', reviewedBy, note: reason }, c);
      if (match === null) {
        throw new ApiError(409, 'MATCH_NOT_REVIEWABLE',
          'Match stopped being reviewable while this request was in flight.');
      }
      const e = await appendAuditEntry({
        ...HUMAN, ...blank, runId: match.runId, actorId: reviewedBy,
        eventType: 'MATCH_REJECTED_BY_HUMAN', subjectType: 'match', subjectId: match.id,
        tier: match.tier, ruleId: match.ruleId, ruleVersion: match.ruleVersion,
        decision: 'human_rejected', confidence: match.confidence,
        reason,
        beforeState: { status: existing.status }, afterState: { status: 'human_rejected' },
        details: { matchId: match.id },
      }, c);
      return { match, sequenceNo: e.sequenceNo };
    });

    // The members return to the exception pool. Re-classifying them is S12's
    // job on the next run rather than something this handler improvises — a
    // route that invents an exception would be business logic in a route, and
    // an exception raised outside the classifier would carry no precedence.
    const byId = await membersById(result.match);
    res.json({
      match: matchSummary(result.match, byId),
      exceptionCreated: null,
      auditEntryIds: [result.sequenceNo],
    });
  }));

  return r;
}

/** 21 · POST /api/runs/:runId/matches — a human asserting records are the same. */
export function manualMatchRouter(): Router {
  const r = Router();

  r.post('/:runId/matches', handler(async (req, res) => {
    const runId = pathParam(req, 'runId');
    found(await runsRepo.findRun(runId), 'RUN_NOT_FOUND', `No run exists with id ${runId}`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const createdBy = requireString(body, 'createdBy');
    const reason = requireString(body, 'reason');

    const members = body['members'];
    if (!Array.isArray(members) || members.length < 2) {
      throw new ApiError(400, 'INVALID_REQUEST', 'members must be an array of at least two records');
    }
    const resolved: import('../types/engine.js').NormalizedTransaction[] = [];
    for (const m of members as Record<string, unknown>[]) {
      const transactionId = requireString(m, 'transactionId');
      const t = found(await txnRepo.findTransaction(transactionId),
        'TRANSACTION_NOT_FOUND', `No transaction exists with id ${transactionId}`);
      if (t.runId !== runId) {
        throw new ApiError(400, 'INVALID_REQUEST',
          `Transaction ${transactionId} belongs to a different run.`);
      }
      // The single-match trigger would refuse this at INSERT; checking first
      // turns a database error into the contract's 409.
      const held = await matchRepo.findMatchesForTransaction(transactionId);
      if (held.some((x) => x.status !== 'human_rejected')) {
        throw new ApiError(409, 'TRANSACTION_ALREADY_MATCHED',
          `Transaction ${transactionId} already belongs to a match.`);
      }
      resolved.push(t);
    }

    const result = await withTransaction(async (c) => {
      const match = await matchRepo.insertMatch(runId, {
        // `manual` is the tier that carries weight: a human asserting two
        // records are the same is not the engine matching them (ADR-043), and
        // the DTO excludes it from the engine match rate for that reason.
        tier: 'manual', status: 'human_confirmed', confidence: 1,
        ruleId: 'MANUAL_MATCH_V1',
        cardinality: resolved.filter((t) => t.sourceSystem === 'gateway').length > 1
          ? 'many_to_one' : 'one_to_one',
        members: resolved.map((t, i) => ({
          transactionId: t.id, role: t.sourceSystem as MemberRole, isAnchor: i === 0,
        })),
        amountDeltaPaise: 0, dateDeltaDays: 0, aliasIds: [], scoreBreakdown: null,
      }, 'human', c);

      const e = await appendAuditEntry({
        ...HUMAN, ...blank, runId, actorId: createdBy,
        eventType: 'MATCH_CREATED_BY_HUMAN', subjectType: 'match', subjectId: match.id,
        tier: 'manual', ruleId: 'MANUAL_MATCH_V1', ruleVersion: 'human',
        decision: 'human_confirmed', confidence: 1,
        reason,
        details: { matchId: match.id, members: match.members.map((x) => x.transactionId) },
      }, c);
      return { match, sequenceNo: e.sequenceNo };
    });

    const byId = new Map(resolved.map((t) => [t.id, t]));
    res.status(201).json({
      match: matchSummary(result.match, byId),
      auditEntryIds: [result.sequenceNo],
    });
  }));

  return r;
}

const ALIAS_TYPES: readonly AliasType[] =
  ['merchant_name', 'counterparty_name', 'reference_id', 'description_token'];
const ALIAS_SCOPES: readonly AliasScope[] = ['gateway', 'bank', 'ledger', 'any'];

export function aliasProposals(raw: unknown): {
  aliasType: AliasType; scopeSource: AliasScope; rawValue: string; canonicalValue: string;
  /**
   * The reviewer has SEEN the rule they are replacing and said replace it
   * anyway (ADR-131). Absent or false means an unconfirmed conflict is refused
   * rather than silently superseding a correct rule.
   */
  confirmConflict: boolean;
}[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ApiError(400, 'INVALID_ALIAS', 'aliasProposals must be an array');
  }
  return raw.map((p: unknown) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const aliasType = o['aliasType'];
    const scopeSource = o['scopeSource'] ?? 'any';
    if (typeof aliasType !== 'string' || !ALIAS_TYPES.includes(aliasType as AliasType)) {
      throw new ApiError(400, 'INVALID_ALIAS',
        `aliasType must be one of: ${ALIAS_TYPES.join(', ')}`);
    }
    if (typeof scopeSource !== 'string' || !ALIAS_SCOPES.includes(scopeSource as AliasScope)) {
      throw new ApiError(400, 'INVALID_ALIAS',
        `scopeSource must be one of: ${ALIAS_SCOPES.join(', ')}`);
    }
    const rawValue = requireString(o, 'rawValue');
    const canonicalValue = requireString(o, 'canonicalValue');
    if (rawValue === canonicalValue) {
      // `no_self_alias` would refuse it at the database; saying so here names
      // the actual problem rather than surfacing a constraint name.
      throw new ApiError(400, 'INVALID_ALIAS', 'rawValue and canonicalValue must differ');
    }
    return {
      aliasType: aliasType as AliasType, scopeSource: scopeSource as AliasScope,
      rawValue, canonicalValue,
      confirmConflict: o['confirmConflict'] === true,
    };
  });
}

async function membersById(
  m: matchRepo.Match,
): Promise<Map<string, import('../types/engine.js').NormalizedTransaction>> {
  const out = new Map<string, import('../types/engine.js').NormalizedTransaction>();
  for (const mem of m.members) {
    const t = await txnRepo.findTransaction(mem.transactionId);
    if (t !== null) out.set(t.id, t);
  }
  return out;
}
