# API Contract

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4
Status: **Locked. This is the contract.** Frontend and backend are built in separate sessions on different days; if this doc and the code disagree, the code is wrong until an ADR says otherwise. Revised by the Day 3 design review (ADR-040…ADR-046).
Companion docs: [schema.md](./schema.md) · [matching-engine.md](./matching-engine.md) · [agent-design.md](./agent-design.md) · [ui-spec.md](./ui-spec.md) · [adr-log.md](./adr-log.md) · [deployment.md](./deployment.md)

Per ARCHITECTURE §7, this is a lightweight table — **not** an OpenAPI/Swagger file. That's explicitly excluded.

---

## 0. Conventions

| Concern | Decision |
|---|---|
| Base path | `/api` — all routes below are relative to it. |
| Format | JSON in, JSON out. The single exception is `POST /api/runs` with file upload, which is `multipart/form-data`. |
| Casing | **`camelCase` on the wire.** Postgres is `snake_case`; the mapping happens once in the repository layer, never in the frontend. |
| Money | Wire format is **`amountPaise: number` (integer)** plus a pre-formatted **`amountDisplay: string`** (`"₹1,234.50"`). The frontend never does currency arithmetic or formatting — one formatter, server-side, so the dashboard and the API can never disagree about a number. |
| Dates | ISO-8601. Business dates as `"2026-08-14"`, instants as `"2026-08-14T08:15:02.000Z"` (UTC). The frontend renders in IST. |
| IDs | UUID strings. |
| Pagination | `?page=1&pageSize=50` (default 50, max 200). Every list response carries a `pagination` object. |
| Errors | Uniform shape (below). Never a bare string, never an HTML error page. |
| Auth | **None.** Out of scope per ARCHITECTURE §5. No headers, no tokens, no session. Reviewer identity is a free-text `reviewedBy` field in the request body. |
| Long operations | A reconciliation run is **asynchronous**: `POST /api/runs` returns `202` immediately with a `runId`; the frontend polls `GET /api/runs/:runId`. See §5. |
| Idempotency | All `GET` are safe. `POST /api/matches/:id/approve` is idempotent — re-approving an already-approved match returns `200` with the existing state, not an error. |

### Error envelope

```json
{
  "error": {
    "code": "RUN_NOT_FOUND",
    "message": "No run exists with id 8f3e…",
    "details": {}
  }
}
```

| HTTP | `code` values used |
|---|---|
| 400 | `INVALID_REQUEST`, `UNSUPPORTED_FILE_TYPE`, `MISSING_REQUIRED_FILE`, `INVALID_ALIAS` |
| 404 | `RUN_NOT_FOUND`, `EXCEPTION_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `MATCH_NOT_FOUND`, `ALIAS_NOT_FOUND`, `SCORE_REPORT_NOT_FOUND`, `INVESTIGATION_NOT_FOUND` |
| 409 | `RUN_NOT_COMPLETE` (metrics or investigations requested too early), `MATCH_NOT_REVIEWABLE` (status isn't `pending_review`), `ALIAS_CONFLICT_UNCONFIRMED`, `EXCEPTION_ALREADY_RESOLVED`, `TRANSACTION_ALREADY_MATCHED`, `INVESTIGATION_IN_PROGRESS` |
| 429 | `AGENT_QUOTA_EXCEEDED` (Q&A rate limit — ADR-056) |
| 503 | `AGENT_DISABLED` (`AGENT_QA_ENABLED=false` or no `ANTHROPIC_API_KEY`) |
| 413 | `FILE_TOO_LARGE` (>10 MB per file) |
| 422 | `PARSE_FAILED` (file readable but not the expected shape), `TRUTH_KEY_MISMATCH` (score report built against different bytes) |
| 500 | `INTERNAL_ERROR` |

---

## 1. Endpoint table

| # | Route | Method | Request | Response | Purpose |
|---|---|---|---|---|---|
| 1 | `/api/health` | GET | — | `{ status, dbConnected, llmConfigured, version }` | Deploy smoke check. |
| 2 | `/api/runs` | POST | `multipart` (3 files) **or** `{ useSeedDataset, datasetSeed?, label?, configOverrides? }` | `202` `{ runId, status, label, startedAt }` | Upload sources / trigger a run. |
| 3 | `/api/runs` | GET | `?page&pageSize` | `{ runs: RunSummary[], pagination }` | Run history for the dashboard's run picker. |
| 4 | `/api/runs/:runId` | GET | — | `RunDetail` (status, progress, counts, metrics when done) | Poll target while a run is in flight. |
| 5 | `/api/runs/:runId/metrics` | GET | — | `Metrics` | The headline numbers panel. `409` if run not complete. |
| 6 | `/api/runs/:runId/exceptions` | GET | `?category&severity&status&search&page&pageSize&sort` | `{ exceptions: ExceptionSummary[], facets, pagination }` | The exception list — the primary screen. |
| 7 | `/api/exceptions/:exceptionId` | GET | — | `ExceptionDetail` (evidence, candidates, explanation, linked records) | Drill-down. |
| 8 | `/api/runs/:runId/matches` | GET | `?tier&status&page&pageSize` | `{ matches: MatchSummary[], pagination }` | Browse what *did* match, per tier. |
| 9 | `/api/runs/:runId/review-queue` | GET | `?page&pageSize` | `{ items: ReviewItem[], pagination }` | Fuzzy matches awaiting human approval. |
| 10 | `/api/matches/:matchId/approve` | POST | `{ reviewedBy, note?, aliasProposals?[] }` | `{ match, aliasesCreated[], auditEntryIds[] }` | Approve a flagged match, optionally teaching an alias. |
| 11 | `/api/matches/:matchId/reject` | POST | `{ reviewedBy, reason }` | `{ match, exceptionCreated, auditEntryIds[] }` | Reject; members return to the exception pool. |
| 12 | `/api/transactions/:transactionId` | GET | — | `TransactionDetail` (normalized + `rawPayload`) | Record inspector. |
| 13 | `/api/transactions/:transactionId/audit` | GET | `?page&pageSize` | `{ entries: AuditEntry[], pagination }` | **Audit trail per transaction.** |
| 14 | `/api/runs/:runId/audit` | GET | `?eventType&actorType&page&pageSize` | `{ entries: AuditEntry[], pagination }` | Whole-run trail. |
| 15 | `/api/aliases` | GET | `?status&aliasType&search&page&pageSize` | `{ aliases: Alias[], pagination }` | Alias management screen. |
| 16 | `/api/aliases` | POST | `{ aliasType, rawValue, canonicalValue, scopeSource?, createdBy, note? }` | `201` `{ alias, superseded?, auditEntryIds[] }` | Create an alias directly. |
| 17 | `/api/aliases/:aliasId` | PATCH | `{ status: "revoked", revokedReason, actor }` | `{ alias, auditEntryIds[] }` | Revoke only. Aliases are never edited in place. |
| 18 | `/api/aliases/:aliasId/history` | GET | — | `{ alias, lineage: Alias[], entries: AuditEntry[] }` | Supersession chain + every event. |
| 19 | `/api/runs/:runId/export` | GET | `?format=csv&scope=exceptions\|matches` | `text/csv` | Download for the pitch/demo. |
| 20 | `/api/exceptions/:exceptionId/resolve` | POST | `{ resolvedBy, resolution, note }` | `{ exception, auditEntryIds[] }` | Mark an exception `human_resolved` or `wont_fix`. (ADR-043) |
| 21 | `/api/runs/:runId/matches` | POST | `{ createdBy, reason, members[], aliasProposals?[] }` | `201` `{ match, auditEntryIds[] }` | **Manual match** — a human asserting records are the same. (ADR-043) |
| 22 | `/api/runs/:runId/audit/verify` | GET | — | `{ valid, entriesChecked, firstDivergenceSequenceNo }` | Recompute the audit hash chain. (ADR-042) |
| 23 | `/api/runs/:runId/score-report` | POST | `ScoreReport` (from `tools/score`) | `201` `{ scoreReportId }` | Offline scorer posts a measurement. (ADR-041) |
| 24 | `/api/runs/:runId/population` | GET | `?kind=excluded\|rejected\|duplicates` | `{ items: PopulationItem[], counts, pagination }` | Rows outside the reconcilable denominator, with the reason for each. |
| 25 | `/api/runs/:runId/investigations` | POST | `{ maxInvestigations?, categories?[] }` | `202` `{ phaseId, status }` | Start Phase A on a completed run. (ADR-048) |
| 26 | `/api/runs/:runId/investigations` | GET | `?verdict&category&page&pageSize` | `{ investigations: InvestigationSummary[], agentMetrics, pagination }` | Analyst results for a run. |
| 27 | `/api/investigations/:investigationId` | GET | — | `InvestigationDetail` (reasoning chain, tool trace, citations, proposal) | Drill-down into one investigation. |
| 28 | `/api/runs/:runId/ask` | POST | `{ question }` | `{ answer, citations[], toolCalls[], steps, costUsd }` | Q&A agent over finalized run results. (ADR-056) |

28 endpoints, all `GET` except nine `POST`s and one `PATCH`. Nothing here needs a `DELETE` — nothing in this system is ever deleted.

**Phase A adds no write endpoints.** Accepting an Analyst proposal routes through endpoints that already exist — 21 (manual match), 16 (create alias), 20 (resolve exception) — with `sourceInvestigationId` in the body so the acceptance is attributed (ADR-051). The Analyst proposes into an inbox that already has a confirmation flow, an audit trail and a UI, which is most of why the layer is buildable in the time available.

**Endpoint 25 does not change `runs.status`.** Phase A is a separate job with its own lifecycle, so a run reaches `completed` exactly when the engine finishes and the polling contract in §5 is unchanged. Agent latency never enters `records_per_sec_wall_clock`.

**Why endpoints 20 and 21 exist.** `exceptions.status` already permitted `human_resolved` and `wont_fix`, and no endpoint could produce either state — the column was unreachable. More importantly, the obvious action from an exception drill-down is *"these two are the same, the engine just couldn't prove it"*, and there was no way to record it. Without these the exception list is a report; with them it is a workflow, which is what a finance controller actually needs (ADR-043).

**Why endpoint 24 exists.** Excluded rows, rejected rows and non-primary duplicates are all removed from the match-rate denominator (ADR-040). Any number with a shrunken denominator invites the question "what did you take out?", and the honest answer is an endpoint that lists exactly that, with a per-row reason. Excluded is not hidden.

---

## 2. Request shapes

### 2 · `POST /api/runs`

**Variant A — upload (multipart/form-data)**

| Part | Required | Notes |
|---|---|---|
| `gatewayFile` | yes | CSV, ≤10 MB |
| `bankFile` | yes | CSV, ≤10 MB |
| `ledgerFile` | yes | CSV, ≤10 MB |
| `label` | no | Defaults to `upload-<ISO timestamp>` |
| `configOverrides` | no | JSON string, same shape as variant B |

**Variant B — seeded dataset (application/json)**

```json
{
  "useSeedDataset": true,
  "datasetSeed": 90210,
  "label": "demo-holdout",
  "configOverrides": {
    "amountTolerancePct": 0.005,
    "amountToleranceFloorPaise": 100,
    "amountToleranceCapPaise": 10000,
    "dateWindowCardDays": [-1, 3],
    "dateWindowUpiDays": [-1, 2],
    "dateWindowLedgerDays": [-1, 1],
    "fuzzyAutoConfirmThreshold": 0.85,
    "fuzzyReviewThreshold": 0.65,
    "ambiguityDeltaThreshold": 0.05,
    "aliasLearningEnabled": true,
    "llmExplainEnabled": true,
    "llmMaxCallsPerRun": 8
  }
}
```

`configOverrides` is optional and every field is optional within it; omitted fields take the `schema.md` defaults. Whatever is finally used is written verbatim into `runs.configSnapshot` and echoed back in `RunDetail`. **`aliasLearningEnabled: false` is how the cold-start match rate is measured** — the dashboard exposes it as a toggle labelled "measure without learned aliases."

### 10 · `POST /api/matches/:matchId/approve`

```json
{
  "reviewedBy": "tejas",
  "note": "Confirmed against the settlement advice.",
  "aliasProposals": [
    {
      "aliasType": "merchant_name",
      "rawValue": "AMZN",
      "canonicalValue": "AMAZON RETAIL",
      "scopeSource": "any",
      "confirmConflict": false
    }
  ]
}
```

`aliasProposals` is optional — approving a match without teaching anything is normal and common.

`confirmConflict` is the safety interlock. If an active alias already maps this key to a *different* canonical value, the server returns `409 ALIAS_CONFLICT_UNCONFIRMED` with the existing mapping in `details`, and **the match is still approved** — only the alias write is held back. The frontend then shows "this contradicts an existing rule: `AMZN → AMAZON PAY`. Replace it?" and re-sends with `confirmConflict: true`, which triggers the supersede-with-penalty flow in `schema.md` §6.3.

> Design note: approval and alias-teaching succeed or fail independently on purpose. A reviewer's judgement about *this* match should never be discarded because of a disagreement about a *general* rule.

### 20 · `POST /api/exceptions/:exceptionId/resolve`

```json
{ "resolvedBy": "tejas", "resolution": "human_resolved",
  "note": "Confirmed with the bank: settlement was held for KYC re-verification." }
```

`resolution` is `human_resolved` | `wont_fix`. **`note` is required for both** — a resolution without a stated reason is the same hole in the audit trail that a reason-less rejection would be. `409 EXCEPTION_ALREADY_RESOLVED` if it is not `open` or `explained`; resolving is not idempotent because the second call would overwrite a different human's reasoning.

### 21 · `POST /api/runs/:runId/matches` — manual match

```json
{
  "createdBy": "tejas",
  "reason": "Settlement advice PDF confirms these are the same payment; the RRN was truncated in the bank file.",
  "members": [
    { "transactionId": "…", "role": "gateway" },
    { "transactionId": "…", "role": "bank" }
  ],
  "aliasProposals": []
}
```

Creates a match with `tier: 'manual'`, `confidence: 1.0000`, `status: 'human_confirmed'`, `rule_id: 'MANUAL_MATCH_V1'`. Any open exceptions on the member records are transitioned to `human_resolved` with a pointer to the match. `409 TRANSACTION_ALREADY_MATCHED` if a member already belongs to a non-rejected match — the human must reject that match first, which keeps the single-match invariant a database fact rather than a UI convention.

**Manual matches are excluded from the engine match rate** and reported in `tierAttribution.manual` (ADR-043). A human fixing something is not the engine matching it, and folding the two together would let a slow afternoon of manual work inflate a number that claims to measure an engine.

### 22 · `GET /api/runs/:runId/audit/verify`

```json
{ "valid": true, "entriesChecked": 4412, "firstDivergenceSequenceNo": null,
  "chainHead": "9f2c…", "verifiedAt": "2026-09-04T11:02:00.000Z" }
```

Recomputes the hash chain (`schema.md` §9.0) and reports the first entry whose recomputed hash disagrees. `valid: false` with a `firstDivergenceSequenceNo` means the log was altered outside the application. Read-only, safe to run at any time, and fast enough to run live during the pitch — which is the point of it existing (ADR-042).

### 23 · `POST /api/runs/:runId/score-report`

Accepts the JSON emitted by `tools/score/`. The server checks `truthKeyHash` against the run's recorded `inputFileHashes` manifest and returns `422 TRUTH_KEY_MISMATCH` if they disagree — scoring a run against a key built from different bytes should be impossible, not merely noticed late.

This is the **only** path by which a ground-truth-derived number enters the database, it writes to `score_reports` and never to `runs.metrics`, and no engine module reads either the truth file or this table (ADR-021, ADR-041).

### 25–27 · Analyst investigations

`POST /api/runs/:runId/investigations` returns `202` and runs Phase A asynchronously; the client polls endpoint 26. `409 RUN_NOT_COMPLETE` if the engine hasn't finished — the Analyst reads finalized output by definition.

`InvestigationDetail` (endpoint 27):

```json
{
  "investigationId": "…", "exceptionId": "…", "status": "concluded",
  "verdict": "RESOLUTION_PROPOSED", "confidence": "high",
  "proposedAction": {
    "type": "MANUAL_MATCH",
    "members": [ { "transactionId": "…", "role": "bank" }, { "transactionId": "…", "role": "gateway" } ],
    "rationale": "Six gateway payments net to this credit once the search pool is widened past the engine's 24-record cap."
  },
  "reasoning": [
    { "step": 1, "tool": "get_exception", "arguments": { "exceptionId": "…" },
      "resultDigest": "UNSPLITTABLE_BATCH, searchBoundExceeded, bound=poolCap(24), credit ₹4,82,110",
      "inference": "The engine stopped on a pool cap, not on a proof. Worth re-testing at wider bounds." },
    { "step": 2, "tool": "search_transactions", "arguments": { "sourceSystem": "gateway", "direction": "credit", "dateRange": ["2026-08-12","2026-08-16"] },
      "resultDigest": "31 unmatched; 19 share counterparty AMAZON RETAIL",
      "inference": "Seven same-counterparty payments fell outside the 24 nearest by date. The truncation was arbitrary here." },
    { "step": 3, "tool": "rerun_subset_search", "arguments": { "poolSize": 48, "maxSubsetSize": 8, "budgetMs": 1500 },
      "resultDigest": "exactly one subset of 6 sums into the credit band",
      "inference": "A unique decomposition exists. Unique, so not ambiguous." }
  ],
  "citations": ["…","…"],
  "groundingPassed": true, "budgetExhausted": false,
  "steps": 5, "toolCalls": 7, "costUsd": 0.0312,
  "model": "claude-sonnet-5", "promptVersion": "agent-v1",
  "humanDisposition": null, "resultingMatchId": null
}
```

`resultDigest` is what the tool actually returned, recorded by the runtime — **not** the model's description of it. `inference` is the model's. Keeping them in separate fields is what lets a reader check the reasoning against the evidence rather than against a paraphrase of it.

Every id in `citations` was verified by the A3 grounding gate to have appeared in a tool result from this investigation (ADR-050). `verdict: "INSUFFICIENT_EVIDENCE"` with `groundingFailure` set means the gate rejected an ungrounded verdict — surfaced, never hidden.

The full ordered tool trace is also in `audit_log` under `subjectType: "investigation"` (ADR-052), so it is hash-chained and covered by endpoint 22's verification.

### 28 · `POST /api/runs/:runId/ask`

```json
{ "question": "Why wasn't settlement SBIN0R52026081412345 matched?" }
```

Returns an answer with clickable citations and the tool calls that produced it. Bounded at 6 steps and 8 tool calls; read-only tools only. `429 AGENT_QUOTA_EXCEEDED` when the per-run (50) or per-hour (100) bucket is exhausted — the demo is public and has no auth by design, so the quota is the mitigation (ADR-056). `503 AGENT_DISABLED` when `AGENT_QA_ENABLED=false`.

### 11 · `POST /api/matches/:matchId/reject`

```json
{ "reviewedBy": "tejas", "reason": "Different customer; RRN collision is coincidental." }
```

`reason` is **required** — a rejection without a stated reason is a hole in the audit trail. On rejection the match becomes `human_rejected`, its members return to the unmatched pool, and they are re-run through exception classification only (not re-matched) so the reviewer's decision isn't immediately undone by the engine.

---

## 3. Response shapes

### `RunSummary` / `RunDetail`

```json
{
  "runId": "8f3e…", "label": "demo-holdout", "status": "completed",
  "datasetSeed": 90210,
  "startedAt": "2026-08-24T09:00:00.000Z", "finishedAt": "2026-08-24T09:00:07.240Z",
  "progress": { "stage": "completed", "pct": 100 },
  "referenceDate": "2026-08-20",
  "recordCounts": { "gateway": 312, "bank": 240, "ledger": 298,
                    "excluded": 27, "rejectedRows": 1, "nonPrimaryDuplicates": 9, "reconcilable": 813 },
  "inputFileHashes": { "gateway": "sha256:…", "bank": "sha256:…", "ledger": "sha256:…" },
  "headline": { "matchRatePct": 82.4, "falsePositiveMatches": 5, "coldStartMatchRatePct": 74.1,
                "exceptionCount": 65, "pendingReviewCount": 11 },
  "configSnapshot": { "…": "as submitted, fully resolved" }
}
```

`RunDetail` = `RunSummary` + `metrics` (null until `completed`) + `errorDetail` (null unless `failed`). `progress.stage` is one of `pending | ingesting | matching | classifying | explaining | completed | failed` — the frontend drives a progress bar off it while polling.

### `Metrics` (endpoint 5)

**Endpoint 5 composes two objects that live in two tables** (`schema.md` §11, ADR-041):

```json
{
  "engine": { "…": "runs.metrics — what the engine did, self-reported" },
  "measured": { "…": "score_reports.report — how right it was, per the answer key" },
  "measuredAt": "2026-09-04T10:15:00.000Z",
  "measuredAgainst": "data/truth/holdout_seed_90210.json",
  "scorerVersion": "1.0.0"
}
```

`schema.md` §11.1 and §11.2 are authoritative for the two shapes; restating them here would guarantee drift.

**`measured` is `null` when no score report exists** — for user-uploaded files there is no answer key, and for a freshly completed run the scorer may not have run yet. The frontend renders "not measured against ground truth" and must **never** substitute engine figures into a slot labelled as measured. A fabricated accuracy number is worse than an absent one; that substitution is the exact failure this whole architecture is built to prevent.

Three fields the frontend must render prominently:

- `measured.matching.falsePositives` — displayed **next to** the match rate, never in a separate tab (ADR-020).
- `engine.coldStart.matchRatePct` — displayed as a paired figure whenever `aliasLearning.humanCorrectionsToDate > 0`.
- `engine.matchRate.denominatorNote` — available on hover over the match rate. A percentage whose denominator is not inspectable is not a measurement.

The pairing is enforced here, at the contract level, rather than left to UI discretion: the endpoint returns both objects or neither, so no frontend decision can separate a match rate from its false-positive count.

`409 RUN_NOT_COMPLETE` if the run hasn't finished.

### `ExceptionSummary` (endpoint 6)

```json
{
  "exceptionId": "…", "category": "AMOUNT_MISMATCH", "secondaryFlags": ["TIMING_DRIFT"],
  "severity": "high", "status": "explained",
  "primaryRecord": {
    "transactionId": "…", "sourceSystem": "gateway", "externalId": "pay_QK29fT10aXbZ81",
    "amountPaise": 123450, "amountDisplay": "₹1,234.50", "txnDate": "2026-08-14",
    "counterpartyRaw": "AMZN"
  },
  "relatedRecordCount": 1,
  "bestCandidateScore": 0.61,
  "explanationText": "The gateway and bank records refer to the same payment…",
  "explanationSource": "llm_cache",
  "suggestedAction": "Check whether a partial capture was applied.",
  "sharedExplanationCount": 14,
  "amountAtRiskPaise": 41200,
  "amountAtRiskDisplay": "₹412.00",
  "requiresHumanConfirmation": false,
  "resolvability": "resolvable_by_human"
}
```

`amountAtRisk` drives severity (ADR-044) and is the exception list's default secondary sort, because a finance controller triages by money.

`resolvability` is `resolvable_by_human` | `needs_external_data` | `unresolvable_from_sources` — derived deterministically from the evidence (was any candidate found? was any anchor present at all?). It answers the question a reviewer asks before opening anything: *is it worth my time?* It is a rule output, never an LLM judgement.

`facets` accompanies the list so the UI can render category/severity filter counts without a second request:

```json
{ "facets": {
    "category": { "AMOUNT_MISMATCH": 18, "MISSING_IN_BANK": 21, "AMBIGUOUS_MATCH": 6 },
    "severity": { "high": 45, "medium": 15, "low": 5 },
    "status":   { "open": 0, "explained": 61, "human_resolved": 4 } } }
```

### `ExceptionDetail` (endpoint 7)

`ExceptionSummary` plus:

```json
{
  "evidence": {
    "candidatesConsidered": 3,
    "candidates": [
      { "transactionId": "…", "sourceSystem": "bank", "score": 0.61,
        "scoreBreakdown": { "anchor": 0.30, "amount": 0.00, "date": 0.20, "counterparty": 0.11 },
        "rejectedBecause": "amount delta ₹412.00 exceeds band ₹100.00",
        "preview": { "externalId": "SBIN0R52…", "amountDisplay": "₹822.50", "txnDate": "2026-08-16" } }
    ],
    "anchorStrength": "strong",
    "aliasesAttempted": [],
    "windowUsed": { "amountBandPaise": 10000, "dateWindow": [-1, 3] },
    "comparisonBasis": "gateway.netAmount vs bank.creditAmount",
    "candidateCapHit": false,
    "severityBasis": { "base": "high", "amountAtRiskPaise": 41200, "escalated": false },
    "searchExhausted": null,
    "searchBoundExceeded": null,
    "displacedByMatchId": null,
    "wouldMatchIfWindowWidened": null
  },
  "detectedByRule": "CLASSIFY_AMOUNT_MISMATCH_V1",
  "ruleVersion": "1.0.0",
  "relatedRecords": [ "…TransactionDetail-lite objects…" ],
  "auditEntryCount": 7
}
```

`rejectedBecause` is generated by the **rule engine**, not the LLM — it is the deterministic answer to "why didn't this match," and it renders even when the explain layer is disabled or the API key is absent.

`searchExhausted` and `searchBoundExceeded` are mutually exclusive and only set on `UNSPLITTABLE_BATCH`. They are **different claims** and the UI must render them differently (ADR-038): "the engine searched every combination and none works" is a proof, while "the engine hit its node budget" is a limit. Collapsing both into the word *unsplittable* would overstate the first and hide the second.

### `MatchSummary` (endpoint 8)

```json
{
  "matchId": "…", "tier": "alias", "cardinality": "one_to_one",
  "status": "auto_confirmed", "confidence": 0.9500,
  "ruleId": "EXACT_PAYMENT_ID_V1", "ruleVersion": "1.0.0",
  "countsTowardEngineMatchRate": true,
  "headlineAmountPaise": 123450, "headlineAmountDisplay": "₹1,234.50",
  "headlineAmountSource": "gateway",
  "members": [
    { "transactionId": "…", "role": "gateway", "externalId": "pay_QK29fT10aXbZ81",
      "amountPaise": 123450, "amountDisplay": "₹1,234.50", "txnDate": "2026-08-14",
      "sourceRowNumber": 87, "counterpartyRaw": "AMZN" },
    { "transactionId": "…", "role": "bank", "externalId": "SBIN0R52…",
      "amountPaise": 119812, "amountDisplay": "₹1,198.12", "txnDate": "2026-08-16",
      "counterpartyRaw": "AMAZON RETAIL IN" }
  ],
  "matchedAt": "2026-08-24T09:00:03.118Z"
}
```

`tier` has **five** values, not four: `exact | alias | fuzzy | batch | manual`. `manual` is the one that carries weight — a human asserting two records are the same (ADR-043) is not the engine matching them.

Every `RecordPreview` carries **`sourceRowNumber`** alongside `transactionId` (ADR-073). It is the only join key `data/truth/` can express — the answer key is written before the engine exists and cannot reference engine-assigned UUIDs — so `tools/score` cannot perform `validation-strategy.md` §5's documented join without it. It also lets a reader find the row in their own file, which a UUID does not.

`countsTowardEngineMatchRate` is **server-computed** (`tier !== "manual" && status !== "human_rejected"`), not a stored column, and the frontend must not re-derive it — the same rule as `eligibleForAliasTier` below, for the same reason. This screen is where a viewer forms an impression of how much the engine did, and a browse list that silently counts human fixes as engine matches would overstate exactly the number the whole project exists to state honestly.

`headlineAmount*` exists because a browse table needs one sortable amount per row, and a match may hold three legs with three different amounts. Its derivation is fixed and reported rather than left implicit: **the gateway leg if one exists, else the bank leg, else the ledger leg**, with `headlineAmountSource` naming which was used. For `one_to_many` the non-headline side keeps its per-member amounts and is not summed here — a summed column would look authoritative while hiding whether the legs actually reconcile, which is the drill-down's job.

### `ReviewItem` (endpoint 9)

```json
{
  "matchId": "…", "tier": "fuzzy", "confidence": 0.7420,
  "scoreBreakdown": { "anchor": 0.20, "amount": 0.35, "date": 0.14, "counterparty": 0.052 },
  "members": [
    { "transactionId": "…", "role": "gateway", "externalId": "pay_QK29…",
      "amountDisplay": "₹1,234.50", "txnDate": "2026-08-14", "counterpartyRaw": "AMZN" },
    { "transactionId": "…", "role": "bank", "externalId": "SBIN0R52…",
      "amountDisplay": "₹1,198.12", "txnDate": "2026-08-16", "counterpartyRaw": "AMAZON RETAIL IN" }
  ],
  "whyFlagged": "Counterparty names differ and no shared reference number was found.",
  "aliasSuggestions": [
    { "aliasType": "merchant_name", "rawValue": "AMZN", "canonicalValue": "AMAZON RETAIL",
      "wouldAlsoResolve": 6, "conflictsWith": null }
  ]
}
```

`aliasSuggestions` is produced **deterministically** — it is simply the differing field pair the reviewer is already looking at, pre-filled into the form. It is not an LLM inference (see `schema.md` §12). `wouldAlsoResolve` counts other records in the same run whose normalized values would be covered by this alias — it tells the reviewer the leverage of the correction they're about to make, and it is the number that makes the alias-learning feature legible in a 5-minute demo.

### `TransactionDetail` (endpoint 12)

```json
{
  "transactionId": "…", "runId": "…",
  "sourceSystem": "gateway", "sourceFile": "gateway_export.csv", "sourceRowNumber": 87,
  "externalId": "pay_QK29fT10aXbZ81",
  "referenceIds": { "paymentId": "pay_QK29fT10aXbZ81", "orderId": "ord_88121", "rrn": null, "utr": null },
  "anchorStrength": "strong",
  "amountPaise": 123450, "amountDisplay": "₹1,234.50",
  "feePaise": 2911, "taxPaise": 524, "netAmountPaise": 120015,
  "currency": "INR", "direction": "credit",
  "txnDate": "2026-08-14", "txnTimestamp": "2026-08-14T18:42:11.000Z", "postingDate": null,
  "counterpartyRaw": "AMZN", "counterpartyNorm": "AMZN", "counterpartyKey": "AMAZON RETAIL",
  "method": "card", "statusRaw": "captured", "statusNorm": "reconcilable",
  "txnType": null, "descriptionRaw": "AMZN*RETAIL 8812",
  "duplicateOfTransactionId": null, "duplicateKind": null,
  "ingestWarnings": [],
  "membership": { "matchId": "…", "role": "gateway", "matchStatus": "auto_confirmed" },
  "exceptionId": null,
  "rawPayload": { "…": "the verbatim source row, unmodified" }
}
```

`rawPayload` is the point of this endpoint, not a debugging extra. Ingestion is lossless and opinion-free (ADR-007) precisely so a panelist can be shown the raw row next to what the parser made of it; an inspector that shows only normalized fields asks the viewer to trust the parser, which is the one thing this screen exists to avoid.

`membership` and `exceptionId` are the two navigation links, and on a **completed** run exactly one of them is non-null for any row whose `statusNorm` is `reconcilable` and whose `duplicateOfTransactionId` is null. Both null on a completed run means a reconcilable record was neither matched nor classified — a bug, and one worth surfacing rather than rendering as an empty panel.

`counterpartyKey` is null until Tier 1.5 runs, so it is null for every row on a run that never reached S7.

### `AuditEntry` (endpoints 13, 14, 18)

```json
{
  "sequenceNo": 4412, "occurredAt": "2026-08-24T09:00:03.118Z",
  "eventType": "MATCH_CONFIRMED_ALIAS",
  "subjectType": "match", "subjectId": "…", "transactionId": "…",
  "actorType": "engine", "actorId": "matching-engine@1.0.0",
  "tier": "alias", "ruleId": "EXACT_PAYMENT_ID_V1", "ruleVersion": "1.0.0",
  "decision": "matched", "confidence": 0.9500,
  "reason": "Counterparty 'AMZN' resolved to 'AMAZON RETAIL' via alias approved by tejas on 2026-08-22; exact predicate then satisfied.",
  "beforeState": null,
  "afterState": { "matchId": "…", "tier": "alias" },
  "details": { "aliasId": "…" }
}
```

Sorted by `sequenceNo` ascending — chronological, and deterministic even for entries written in the same millisecond.

### `Alias` (endpoints 15–18)

```json
{
  "aliasId": "…", "aliasType": "merchant_name", "scopeSource": "any",
  "rawValue": "AMZN", "normalizedValue": "AMZN", "canonicalValue": "AMAZON RETAIL",
  "status": "active",
  "confirmationCount": 2, "conflictCount": 0, "appliedCount": 27,
  "eligibleForAliasTier": true,
  "lastAppliedAt": "2026-08-24T09:00:03.118Z",
  "createdFromMatchId": "…", "createdBy": "tejas", "approvedAt": "2026-08-22T14:10:00.000Z",
  "supersededBy": null, "revokedReason": null
}
```

`eligibleForAliasTier` is a **server-computed** boolean (`conflictCount === 0 || confirmationCount >= 2`), not a stored column. The frontend must not re-derive that rule — one place owns it, and that place is the server.

### Endpoint 19 · CSV export

Not JSON. `text/csv; charset=utf-8`, with

```
Content-Disposition: attachment; filename="recon-<runId>-<scope>-<referenceDate>.csv"
```

**`scope=exceptions`** — one row per exception:

```
run_id, reference_date, exception_id, category, secondary_flags, severity, status,
source_system, source_row_number, external_id, amount_paise, amount_inr, txn_date,
counterparty_raw, candidates_considered, explanation, explanation_source, suggested_action
```

**`scope=matches`** — **one row per member**, not per match, with `match_id` repeated across a match's rows. A single row per match would need an array column, which is unusable in the spreadsheet this file exists to be opened in:

```
run_id, reference_date, match_id, tier, cardinality, status, confidence, rule_id,
counts_toward_engine_match_rate, member_source_system, member_source_row_number,
member_external_id, member_amount_paise, member_amount_inr, member_txn_date, member_role
```

Four rules this format is carrying:

- **`run_id` and `reference_date` are on every row.** A CSV leaves the application and loses all of its context; a number in a spreadsheet with no run identity is the kind of artifact that gets quoted back at you attached to the wrong run.
- **`amount_paise` is authoritative and `amount_inr` is derived at serialization** for human reading (ADR-006). Both are emitted from the same value in one place, so they cannot drift; the integer is the one to re-import.
- **`explanation_source` travels next to `explanation`,** so a template fallback is never mistaken for model-written prose (`schema.md` §10.1).
- **No ground-truth columns, ever.** This is engine output. Precision, recall and false-positive counts live in `score_reports` and reach the client through endpoint 5's `measured` object (ADR-041). An export that mixed them would put a measured number in a file with no record of what it was measured against.

### `PopulationItem` (endpoint 24)

The honest-denominator surface. Every row removed from the reconcilable population, with the reason it was removed.

```json
{
  "items": [
    { "kind": "excluded",
      "sourceSystem": "gateway", "sourceRowNumber": 141, "transactionId": "…",
      "externalId": "pay_QK7712xxA", "amountPaise": 45000, "amountDisplay": "₹450.00",
      "txnDate": "2026-08-13", "statusRaw": "failed", "statusNorm": "excluded_failed",
      "reason": "Gateway status 'failed' — never settled, so there is nothing to reconcile it against.",
      "primaryTransactionId": null, "duplicateKind": null, "rawLine": null, "parseError": null },

    { "kind": "duplicate",
      "sourceSystem": "gateway", "sourceRowNumber": 214, "transactionId": "…",
      "externalId": "pay_QK29fT10aXbZ81", "amountPaise": 123450, "amountDisplay": "₹1,234.50",
      "txnDate": "2026-08-14", "statusRaw": "captured", "statusNorm": "reconcilable",
      "reason": "Same strong anchor pay_QK29fT10aXbZ81 as row 87; retry artifact (ADR-034).",
      "primaryTransactionId": "…", "duplicateKind": "exact", "rawLine": null, "parseError": null },

    { "kind": "rejected",
      "sourceSystem": "bank", "sourceRowNumber": 58, "transactionId": null,
      "externalId": null, "amountPaise": null, "amountDisplay": null,
      "txnDate": null, "statusRaw": null, "statusNorm": null,
      "reason": "Unparseable: amount column held '12,34,5O.00' — letter O in a numeric field.",
      "primaryTransactionId": null, "duplicateKind": null,
      "rawLine": "58,SBIN0R52…,12,34,5O.00,2026-08-16,…", "parseError": "AMOUNT_UNPARSEABLE" }
  ],
  "counts": { "excluded": 27, "rejected": 1, "duplicates": 9, "reconcilable": 813, "totalRows": 850 },
  "pagination": { "page": 1, "pageSize": 50, "total": 37 }
}
```

**The three kinds are not variations of one thing, and the shape says so.** `excluded` rows parsed cleanly and were removed by status. `duplicate` rows are real, parsed records that lost the primary election in S4. `rejected` rows **never became transactions at all** — they live in `runs.rejected_rows` (`schema.md` §4), not in `transactions`, so `transactionId` is `null` and there are no normalized fields to report. They carry `rawLine` and `parseError` instead. A client that assumes `transactionId` is always present will break on the first malformed row in the dataset.

**`primaryTransactionId` on a duplicate is the link that makes the removal honest.** "This row was taken out of the denominator" is only a complete statement with "…because that row represents it" attached, and the UI should make it clickable.

**`reason` is always populated and always human-readable.** A code alone (`excluded_failed`) tells a panelist nothing; this endpoint exists specifically to answer "what did you take out?" in a form that does not require reading the schema.

**`counts` must reconcile: `excluded + rejected + duplicates + reconcilable === totalRows`** — ADR-040's denominator definition restated as an identity the client can check. The arithmetic is the feature. A denominator that cannot be added up is a denominator nobody should trust, and if the identity ever fails, a row is unaccounted for and the match rate is wrong. The frontend renders the sum; the server should assert it before responding.

### `InvestigationSummary` and `agentMetrics` (endpoint 26)

```json
{
  "investigations": [
    { "investigationId": "…", "exceptionId": "…", "category": "UNSPLITTABLE_BATCH",
      "severity": "high", "status": "concluded",
      "verdict": "RESOLUTION_PROPOSED", "confidence": "high",
      "proposedActionType": "MANUAL_MATCH",
      "summary": "Six gateway payments net to this credit once the pool is widened past the engine's cap.",
      "groundingPassed": true, "groundingFailure": null, "budgetExhausted": false,
      "steps": 5, "toolCalls": 7, "costUsd": 0.0312,
      "humanDisposition": null, "resultingMatchId": null,
      "startedAt": "…", "finishedAt": "…" }
  ],
  "agentMetrics": {
    "investigationsRun": 20,
    "verdictDistribution": { "RESOLUTION_PROPOSED": 7, "CONFIRMED_UNRESOLVABLE": 9,
                             "NEEDS_EXTERNAL_DATA": 2, "INSUFFICIENT_EVIDENCE": 2 },
    "meanSteps": 4.8, "meanToolCalls": 6.4,
    "groundingFailures": 2, "budgetExhaustions": 1,
    "tokensIn": 128400, "tokensOut": 9120, "costUsdTotal": 0.61,
    "promptCacheHitRatePct": 94.0,
    "model": "claude-sonnet-5", "promptVersion": "agent-v1"
  },
  "pagination": { "page": 1, "pageSize": 25, "total": 20 }
}
```

**`agentMetrics` is OPERATIONAL ONLY, and the omission is the design.** Everything in it is computed from `agent_investigations` with no ground truth involved (`agent-design.md` §7). The Analyst's ground-truth metrics — false-despair recovered, proposal precision, **hallucinated resolutions (must be 0)** and unresolvable agreement (ADR-053) — are deliberately **not here**. They are produced offline by `tools/score`, stored in `score_reports`, and reach the client through endpoint 5's `measured` object.

This is endpoint 5's `engine` / `measured` split applied to the agent, for exactly the reason ADR-041 gives: one object is the agent's account of itself, the other is a measurement of it. Returning `proposalPrecision` from this endpoint would be a ground-truth number arriving out of the engine's own table, which is the specific failure ADR-041 exists to prevent — and it would be a far easier mistake to make here than on endpoint 5, because both kinds of number are about the same subject.

**`groundingFailures` is reported, never suppressed.** A rising count means the prompt or the tools need work (`agent-design.md` §7); hiding it would remove the only signal that the gate is doing something.

`proposedActionType` is a bare type here, not the full action — the list is a triage surface, and the members a `MANUAL_MATCH` proposes are what endpoint 27 is for. `summary` is the model's own one-line conclusion and is the only model-authored prose in this response.

---

## 4. Endpoint-to-screen map

Sanity check that every endpoint has a consumer and every screen has its data:

| Screen | Endpoints |
|---|---|
| Run launcher | 2, 3 |
| Run progress | 4 (poll) |
| Dashboard / headline metrics | 5 |
| Exception list (primary screen) | 6 |
| Exception drill-down | 7, 13 |
| Matches browser | 8, 12 |
| Review queue | 9, 10, 11 |
| Alias management | 15, 16, 17, 18 |
| Transaction inspector + audit trail | 12, 13 |
| Run-level audit | 14 |
| Analyst panel on exception detail | 26, 27 |
| Analyst summary block on dashboard | 26 |
| Q&A box | 28 |
| Exception resolution | 20 |
| Manual match (from exception drill-down or record inspector) | 21, 12 |
| Audit chain verification (pitch demo) | 22 |
| Excluded / rejected / duplicate rows | 24 |
| Export for the demo | 19 |
| Deploy check | 1 |

Endpoint 23 (`score-report`) has no screen: it is written by `tools/score` and read only through endpoint 5. That is the one deliberate asymmetry in this table, and it is the boundary ADR-041 exists to draw.

No other orphans in either direction.

---

## 5. Async run protocol

```
POST /api/runs ──► 202 { runId, status: "pending" }
       │
       └─► frontend polls GET /api/runs/:runId every 750 ms
              status: ingesting → matching → classifying → explaining → completed
       │
       └─► on "completed": GET /api/runs/:runId/metrics
                           GET /api/runs/:runId/exceptions
```

**Polling, not WebSockets or SSE.** A 300-record run completes in a few seconds; the entire polling loop is a handful of requests. A realtime transport is infrastructure the demo doesn't need and one more thing that can fail in front of a panel. **Flagged as a deliberate non-choice, not an oversight.**

If a run fails, `status: "failed"` with a populated `errorDetail`. Partial results are preserved and readable — a run that dies during the explain phase still has all its matches and exceptions, and endpoints 6–8 serve them normally.

---

## 6. Out of scope for this contract

- Authentication / authorization headers — ARCHITECTURE §5.
- OpenAPI/Swagger generation — ARCHITECTURE §7 explicitly excludes it.
- Webhooks or callbacks on run completion — nothing external consumes this.
- Bulk alias import — **flagged**; may be worth it on Day 8 purely to seed the demo, decide then.
- `DELETE` on anything — the system is append-only by design; revocation is a status change.
