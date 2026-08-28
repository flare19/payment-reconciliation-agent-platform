/**
 * Wire serialization — the one place a database row becomes a DTO.
 *
 * Routes are thin (CLAUDE.md §4.3), and "thin" fails in a specific way if the
 * mapping is inlined per handler: the same object gets two shapes on two
 * endpoints and the frontend gets to discover which. So every DTO in
 * `api-contract.md` §3 is built exactly once, here.
 *
 * ── Three fields are SERVER-COMPUTED, and the contract says so explicitly ──
 *
 *   `amountDisplay`               one formatter, server-side, so the dashboard
 *                                 and the API can never disagree about a number
 *   `countsTowardEngineMatchRate` `tier !== 'manual' && status !== 'human_rejected'`
 *   `eligibleForAliasTier`        `conflictCount === 0 || confirmationCount >= 2`
 *
 * The last two are rules the frontend must NOT re-derive. Both are places where
 * a viewer forms an impression of how much the ENGINE did, and a second copy of
 * either rule is a second answer that will eventually disagree with this one.
 */

import { formatPaise } from '../services/ingestion/money.js';
import type { MoneyDto, Pagination } from '../types/dto.js';
import type { RunStatus } from '../types/domain.js';
import type { Run } from '../repositories/runs.js';
import type { Match } from '../repositories/matches.js';
import type { ExceptionRecord } from '../repositories/exceptions.js';
import type { Alias } from '../repositories/aliases.js';
import type { Investigation, AgentQuestion } from '../repositories/investigations.js';
import type { NormalizedTransaction } from '../types/engine.js';
import type { StoredAuditEntry } from '../services/audit/hash-chain.js';

export function money(paise: number): MoneyDto {
  return { amountPaise: paise, amountDisplay: formatPaise(paise) };
}

export function paginate(page: number, pageSize: number, total: number): Pagination {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * `progress.stage` drives the frontend's progress bar while polling (§5). The
 * percentages are a rendering aid, not a measurement — they are stage ordinals,
 * and are deliberately coarse rather than pretending to know how far through a
 * stage a run is.
 */
const STAGE_PCT: Record<RunStatus, number> = {
  pending: 0, ingesting: 15, matching: 45, classifying: 75,
  explaining: 90, completed: 100, failed: 100,
};

export function runSummary(r: Run): Record<string, unknown> {
  const c = r.recordCounts;
  const m = (r.metrics ?? {}) as Record<string, Record<string, unknown> | undefined>;
  return {
    runId: r.id,
    label: r.label,
    status: r.status,
    datasetSeed: r.datasetSeed,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    progress: { stage: r.status, pct: STAGE_PCT[r.status] },
    referenceDate: r.referenceDate,
    recordCounts: {
      gateway: c['gateway'] ?? 0, bank: c['bank'] ?? 0, ledger: c['ledger'] ?? 0,
      excluded: c['excluded'] ?? 0,
      // The contract names this `rejectedRows`; the column is `rejected_row_count`.
      rejectedRows: r.rejectedRowCount,
      nonPrimaryDuplicates: c['nonPrimaryDuplicates'] ?? 0,
      reconcilable: c['reconcilable'] ?? 0,
    },
    inputFileHashes: r.inputFileHashes,
    // `headline` is read from `runs.metrics`, which S14 (U8) fills. Until then it
    // is null rather than zeroed: a match rate of 0.0% and an absent match rate
    // are different claims, and only one of them is true right now.
    headline: m['matchRate'] === undefined ? null : {
      matchRatePct: m['matchRate']['matchRatePct'] ?? null,
      falsePositiveMatches: null,        // measured, not engine-computed (ADR-041)
      coldStartMatchRatePct: (m['coldStart'] ?? {})['matchRatePct'] ?? null,
      exceptionCount: m['exceptions']?.['total'] ?? null,
      pendingReviewCount: m['review']?.['pendingReviewCount'] ?? null,
    },
    configSnapshot: r.configSnapshot,
  };
}

/** `RunDetail` = `RunSummary` + metrics + errorDetail (§3). */
export function runDetail(r: Run): Record<string, unknown> {
  return { ...runSummary(r), metrics: r.metrics, errorDetail: r.errorDetail };
}

/** A record as it appears inside another object — a match member, a candidate preview. */
export function recordPreview(t: NormalizedTransaction): Record<string, unknown> {
  return {
    transactionId: t.id,
    sourceSystem: t.sourceSystem,
    externalId: t.externalId,
    ...money(t.amountPaise),
    txnDate: t.txnDate,
    counterpartyRaw: t.counterpartyRaw,
  };
}

export function transactionDetail(
  t: NormalizedTransaction,
  links: {
    membership: { matchId: string; role: string; matchStatus: string } | null;
    exceptionId: string | null;
  },
): Record<string, unknown> {
  return {
    transactionId: t.id,
    runId: t.runId,
    sourceSystem: t.sourceSystem,
    sourceFile: t.sourceFile,
    sourceRowNumber: t.sourceRowNumber,
    externalId: t.externalId,
    referenceIds: t.referenceIds,
    anchorStrength: t.anchorStrength,
    ...money(t.amountPaise),
    feePaise: t.feePaise,
    taxPaise: t.taxPaise,
    netAmountPaise: t.netAmountPaise,
    currency: t.currency,
    direction: t.direction,
    txnDate: t.txnDate,
    txnTimestamp: t.txnTimestamp,
    postingDate: t.postingDate,
    counterpartyRaw: t.counterpartyRaw,
    counterpartyNorm: t.counterpartyNorm,
    counterpartyKey: t.counterpartyKey,
    method: t.method,
    statusRaw: t.statusRaw,
    statusNorm: t.statusNorm,
    txnType: t.txnType,
    descriptionRaw: t.descriptionRaw,
    duplicateOfTransactionId: t.duplicateOfTransactionId,
    duplicateKind: t.duplicateKind,
    ingestWarnings: t.ingestWarnings,
    membership: links.membership,
    exceptionId: links.exceptionId,
    // The POINT of this endpoint, not a debugging extra: a panelist can be shown
    // the raw row beside what the parser made of it. An inspector that shows
    // only normalized fields asks the viewer to trust the parser, which is the
    // one thing this screen exists to avoid.
    rawPayload: t.rawPayload,
  };
}

/**
 * `headlineAmount*` — a browse table needs ONE sortable amount per row, and a
 * match may hold three legs with three different amounts. The derivation is
 * fixed and REPORTED rather than left implicit: gateway leg if present, else
 * bank, else ledger. `one_to_many` legs are not summed — a summed column would
 * look authoritative while hiding whether the legs actually reconcile.
 */
function headlineAmount(
  members: Match['members'], byId: ReadonlyMap<string, NormalizedTransaction>,
): { paise: number; source: string } | null {
  for (const role of ['gateway', 'bank', 'ledger'] as const) {
    const m = members.find((x) => x.role === role);
    if (m === undefined) continue;
    const t = byId.get(m.transactionId);
    if (t !== undefined) return { paise: t.amountPaise, source: role };
  }
  return null;
}

export function matchSummary(
  m: Match, byId: ReadonlyMap<string, NormalizedTransaction>,
): Record<string, unknown> {
  const headline = headlineAmount(m.members, byId);
  return {
    matchId: m.id,
    tier: m.tier,
    cardinality: m.cardinality,
    status: m.status,
    confidence: m.confidence,
    ruleId: m.ruleId,
    ruleVersion: m.ruleVersion,
    // SERVER-COMPUTED. A browse list that silently counted human fixes as engine
    // matches would overstate exactly the number this project exists to state
    // honestly (ADR-043).
    countsTowardEngineMatchRate: m.tier !== 'manual' && m.status !== 'human_rejected',
    headlineAmountPaise: headline?.paise ?? null,
    headlineAmountDisplay: headline === null ? null : formatPaise(headline.paise),
    headlineAmountSource: headline?.source ?? null,
    members: m.members.map((mem) => {
      const t = byId.get(mem.transactionId);
      return t === undefined
        ? { transactionId: mem.transactionId, role: mem.role }
        : { ...recordPreview(t), role: mem.role };
    }),
    matchedAt: iso(m.matchedAt),
  };
}

/**
 * `resolvability` (§3) — a rule output, never an LLM judgement.
 *
 * It answers the question a reviewer asks before opening anything: *is this
 * worth my time?* Derived only from what the engine actually recorded:
 *   - a candidate was found and scored → a human can adjudicate it;
 *   - no candidate, but the record carries SOME reference → the counterpart may
 *     exist outside these three files;
 *   - no candidate and no anchor at all → there was nothing to find, and saying
 *     so is more useful than implying a human could dig it up.
 */
export function resolvabilityOf(e: ExceptionRecord): string {
  if ((e.evidence.candidates?.length ?? 0) > 0) return 'resolvable_by_human';
  if (e.evidence.anchorStrength !== 'none') return 'needs_external_data';
  return 'unresolvable_from_sources';
}

export function exceptionSummary(
  e: ExceptionRecord,
  primary: NormalizedTransaction | null,
  sharedExplanationCount: number | null,
): Record<string, unknown> {
  return {
    exceptionId: e.id,
    category: e.category,
    secondaryFlags: e.secondaryFlags,
    severity: e.severity,
    status: e.status,
    primaryRecord: primary === null ? null : recordPreview(primary),
    relatedRecordCount: e.relatedTransactionIds.length,
    bestCandidateScore: e.bestCandidateScore,
    explanationText: e.explanationText,
    explanationSource: e.explanationSource,
    suggestedAction: e.suggestedAction,
    sharedExplanationCount,
    amountAtRiskPaise: e.amountAtRiskPaise,
    amountAtRiskDisplay: e.amountAtRiskPaise === null ? null : formatPaise(e.amountAtRiskPaise),
    requiresHumanConfirmation: e.requiresHumanConfirmation,
    resolvability: resolvabilityOf(e),
  };
}

export function exceptionDetail(
  e: ExceptionRecord,
  primary: NormalizedTransaction | null,
  related: NormalizedTransaction[],
  byId: ReadonlyMap<string, NormalizedTransaction>,
  sharedExplanationCount: number | null,
  auditEntryCount: number,
): Record<string, unknown> {
  return {
    ...exceptionSummary(e, primary, sharedExplanationCount),
    evidence: {
      ...e.evidence,
      // `rejectedBecause` comes from the RULE ENGINE, not the LLM — it is the
      // deterministic answer to "why didn't this match", and it renders even
      // with the explain layer disabled or the API key absent.
      candidates: (e.evidence.candidates ?? []).map((c) => {
        const t = byId.get(c.transactionId);
        return {
          ...c,
          preview: t === undefined ? null : {
            externalId: t.externalId, amountDisplay: formatPaise(t.amountPaise), txnDate: t.txnDate,
          },
        };
      }),
    },
    detectedByRule: e.detectedByRule,
    ruleVersion: e.ruleVersion,
    relatedRecords: related.map(recordPreview),
    auditEntryCount,
  };
}

export function auditEntry(e: StoredAuditEntry): Record<string, unknown> {
  return {
    sequenceNo: e.sequenceNo,
    occurredAt: e.occurredAt instanceof Date ? e.occurredAt.toISOString() : e.occurredAt,
    eventType: e.eventType,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    transactionId: e.transactionId,
    actorType: e.actorType,
    actorId: e.actorId,
    tier: e.tier,
    ruleId: e.ruleId,
    ruleVersion: e.ruleVersion,
    decision: e.decision,
    confidence: e.confidence,
    reason: e.reason,
    beforeState: e.beforeState,
    afterState: e.afterState,
    details: e.details,
  };
}

export function aliasDto(a: Alias): Record<string, unknown> {
  return {
    aliasId: a.id,
    aliasType: a.aliasType,
    scopeSource: a.scopeSource,
    rawValue: a.rawValue,
    normalizedValue: a.normalizedValue,
    canonicalValue: a.canonicalValue,
    status: a.status,
    confirmationCount: a.confirmationCount,
    conflictCount: a.conflictCount,
    appliedCount: a.appliedCount,
    // SERVER-COMPUTED by the repository's SELECT list. The frontend must not
    // re-derive it — one place owns the §6.3 penalty rule.
    eligibleForAliasTier: a.eligibleForAliasTier,
    lastAppliedAt: iso(a.lastAppliedAt),
    createdFromMatchId: a.createdFromMatchId,
    createdBy: a.createdBy,
    approvedAt: iso(a.approvedAt),
    supersededBy: a.supersededBy,
    revokedReason: a.revokedReason,
  };
}

export function investigationDto(i: Investigation): Record<string, unknown> {
  return {
    investigationId: i.id,
    runId: i.runId,
    exceptionId: i.exceptionId,
    status: i.status,
    verdict: i.verdict,
    // A LABEL, never a number, and deliberately a different TYPE from
    // matches.confidence — the engine's is COMPUTED, the agent's is ASSERTED
    // (ADR-052). Same shape would invite averaging across two different things.
    confidence: i.confidence,
    proposedAction: i.proposedAction,
    reasoning: i.reasoning,
    citations: i.citations,
    groundingPassed: i.groundingPassed,
    groundingFailure: i.groundingFailure,
    budgetExhausted: i.budgetExhausted,
    steps: i.steps,
    toolCalls: i.toolCalls,
    tokensIn: i.tokensIn,
    tokensOut: i.tokensOut,
    costUsd: i.costUsd,
    model: i.model,
    promptVersion: i.promptVersion,
    humanDisposition: i.humanDisposition,
    resultingMatchId: i.resultingMatchId,
    startedAt: iso(i.startedAt),
    finishedAt: iso(i.finishedAt),
  };
}

export function questionDto(q: AgentQuestion): Record<string, unknown> {
  return {
    questionId: q.id,
    runId: q.runId,
    question: q.question,
    answer: q.answer,
    citations: q.citations,
    steps: q.steps,
    toolCalls: q.toolCalls,
    tokensIn: q.tokensIn,
    tokensOut: q.tokensOut,
    costUsd: q.costUsd,
    groundingPassed: q.groundingPassed,
    askedAt: iso(q.askedAt),
  };
}
