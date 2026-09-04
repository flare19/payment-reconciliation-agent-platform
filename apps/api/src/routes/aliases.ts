/**
 * Endpoints 15–18 — the alias management screen.
 *
 * Thin: parse, validate, delegate, serialize (CLAUDE.md §4.3).
 *
 * Aliases are NEVER edited in place. Endpoint 17 is a PATCH whose only legal
 * body is `{ status: "revoked", … }`, and a conflicting assertion through
 * endpoint 16 SUPERSEDES rather than overwrites (§6.3). That is why 18 exists at
 * all: the lineage is how a reviewer sees how a contested alias reached its
 * current value, which an in-place edit would have destroyed.
 */

import { Router } from 'express';
import { ApiError } from '../app.js';
import { withTransaction } from '../db/pool.js';
import * as aliasRepo from '../repositories/aliases.js';
import { appendAuditEntry, readChain } from '../repositories/audit.js';
import { normalizeCounterparty } from '../services/ingestion/normalize.js';
import {
  handler, found, pageParams, stringParam, enumParam, requireString, uuidParam,
} from './helpers.js';
import { aliasDto, auditEntry, paginate } from './serialize.js';
import { aliasProposals } from './matches.js';

const blank = {
  transactionId: null, tier: null, ruleId: null, ruleVersion: null,
  decision: null, confidence: null,
} as const;

export function aliasesRouter(): Router {
  const r = Router();

  // 15 · GET /api/aliases
  r.get('/', handler(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req);
    const status = enumParam(req, 'status', ['active', 'superseded', 'revoked'] as const);
    const aliasType = enumParam(req, 'aliasType',
      ['merchant_name', 'counterparty_name', 'reference_id', 'description_token'] as const);
    const search = stringParam(req, 'search');

    const { aliases, total } = await aliasRepo.listAliases({
      ...(status === undefined ? {} : { status }),
      ...(aliasType === undefined ? {} : { aliasType }),
      ...(search === undefined ? {} : { search }),
    }, pageSize, offset);
    res.json({ aliases: aliases.map(aliasDto), pagination: paginate(page, pageSize, total) });
  }));

  // 16 · POST /api/aliases — create directly.
  r.post('/', handler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const createdBy = requireString(body, 'createdBy');
    // Reuse the proposal validator, so a direct create and an approve-with-alias
    // cannot disagree about what a valid alias is.
    const [proposal] = aliasProposals([{
      aliasType: body['aliasType'], scopeSource: body['scopeSource'] ?? 'any',
      rawValue: body['rawValue'], canonicalValue: body['canonicalValue'],
    }]);

    const result = await withTransaction(async (c) => {
      const upsert = await aliasRepo.upsertAlias({
        aliasType: proposal!.aliasType, scopeSource: proposal!.scopeSource,
        rawValue: proposal!.rawValue,
        normalizedValue: normalizeCounterparty(proposal!.rawValue) ?? proposal!.rawValue,
        canonicalValue: normalizeCounterparty(proposal!.canonicalValue) ?? proposal!.canonicalValue,
        createdBy,
      }, c);
      const e = await appendAuditEntry({
        ...blank, runId: null, actorType: 'human', actorId: createdBy,
        eventType: upsert.outcome === 'reaffirmed' ? 'ALIAS_REAFFIRMED'
          : upsert.outcome === 'superseded' ? 'ALIAS_CONFLICT_SUPERSEDED' : 'ALIAS_CREATED',
        subjectType: 'alias', subjectId: upsert.alias.id,
        reason: optionalNote(body)
          ?? `${createdBy} asserted '${upsert.alias.rawValue}' resolves to `
             + `'${upsert.alias.canonicalValue}'`,
        beforeState: upsert.outcome === 'superseded'
          ? { aliasId: upsert.previous.id, canonicalValue: upsert.previous.canonicalValue }
          : null,
        afterState: { aliasId: upsert.alias.id, canonicalValue: upsert.alias.canonicalValue,
          eligibleForAliasTier: upsert.alias.eligibleForAliasTier },
        details: { outcome: upsert.outcome },
      }, c);
      return { upsert, sequenceNo: e.sequenceNo };
    });

    // A contested alias falls back to human review rather than auto-resolving
    // (§6.3's penalty). `superseded` is returned so the caller sees that
    // happened, rather than discovering it later as a match that did not fire.
    res.status(201).json({
      alias: aliasDto(result.upsert.alias),
      superseded: result.upsert.outcome === 'superseded'
        ? aliasDto(result.upsert.previous)
        : null,
      auditEntryIds: [result.sequenceNo],
    });
  }));

  // 17 · PATCH /api/aliases/:aliasId — revoke only.
  r.patch('/:aliasId', handler(async (req, res) => {
    const aliasId = uuidParam(req, 'aliasId');
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body['status'] !== 'revoked') {
      throw new ApiError(400, 'INVALID_REQUEST',
        'Aliases are never edited in place; the only legal PATCH is { status: "revoked" }.');
    }
    const revokedReason = requireString(body, 'revokedReason');
    const actor = requireString(body, 'actor');

    const existing = found(await aliasRepo.findAlias(aliasId),
      'ALIAS_NOT_FOUND', `No alias exists with id ${aliasId}`);

    const result = await withTransaction(async (c) => {
      const revoked = await aliasRepo.revokeAlias(aliasId, revokedReason, c);
      if (revoked === null) {
        throw new ApiError(409, 'INVALID_ALIAS',
          `Alias is ${existing.status}; only an active alias can be revoked.`);
      }
      const e = await appendAuditEntry({
        ...blank, runId: null, actorType: 'human', actorId: actor,
        eventType: 'ALIAS_REVOKED', subjectType: 'alias', subjectId: revoked.id,
        reason: revokedReason,
        beforeState: { status: existing.status },
        afterState: { status: 'revoked' },
        details: { aliasId: revoked.id },
      }, c);
      return { revoked, sequenceNo: e.sequenceNo };
    });

    res.json({ alias: aliasDto(result.revoked), auditEntryIds: [result.sequenceNo] });
  }));

  // 18 · GET /api/aliases/:aliasId/history
  r.get('/:aliasId/history', handler(async (req, res) => {
    const aliasId = uuidParam(req, 'aliasId');
    const alias = found(await aliasRepo.findAlias(aliasId),
      'ALIAS_NOT_FOUND', `No alias exists with id ${aliasId}`);
    const lineage = await aliasRepo.aliasLineage(aliasId);
    // Alias admin happens outside any run, so its entries live on the NULL
    // chain (schema.md §9.1). Filtering to this alias's own lineage keeps the
    // history readable without a second table — which is ADR-014's whole point:
    // one timeline, one query.
    const ids = new Set(lineage.map((a) => a.id));
    const entries = (await readChain(null)).filter((e) => ids.has(e.subjectId));
    res.json({
      alias: aliasDto(alias),
      lineage: lineage.map(aliasDto),
      entries: entries.map(auditEntry),
    });
  }));

  return r;
}

function optionalNote(body: Record<string, unknown>): string | null {
  const v = body['note'];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
