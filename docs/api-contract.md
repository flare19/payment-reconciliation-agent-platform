# API Contract

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4
Status: **Day 2 architecture — this is the contract. Frontend and backend are built in separate sessions on different days; if this doc and the code disagree, the code is wrong until an ADR says otherwise.**
Companion docs: [schema.md](./schema.md) · [adr-log.md](./adr-log.md) · [deployment.md](./deployment.md)

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
| 404 | `RUN_NOT_FOUND`, `EXCEPTION_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `MATCH_NOT_FOUND`, `ALIAS_NOT_FOUND` |
| 409 | `RUN_NOT_COMPLETE` (metrics requested too early), `MATCH_NOT_REVIEWABLE` (status isn't `pending_review`), `ALIAS_CONFLICT_UNCONFIRMED` |
| 413 | `FILE_TOO_LARGE` (>10 MB per file) |
| 422 | `PARSE_FAILED` (file readable but not the expected shape) |
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

19 endpoints, all `GET` except four `POST`s and one `PATCH`. Nothing here needs a `DELETE` — nothing in this system is ever deleted.

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
  "recordCounts": { "gateway": 312, "bank": 240, "ledger": 298, "excluded": 27, "reconcilable": 823 },
  "headline": { "matchRatePct": 82.4, "exceptionCount": 65, "pendingReviewCount": 11 },
  "configSnapshot": { "…": "as submitted, fully resolved" }
}
```

`RunDetail` = `RunSummary` + `metrics` (null until `completed`) + `errorDetail` (null unless `failed`). `progress.stage` is one of `pending | ingesting | matching | classifying | explaining | completed | failed` — the frontend drives a progress bar off it while polling.

### `Metrics` (endpoint 5)

The full object from `schema.md` §11, verbatim. Restating it here would guarantee drift; `schema.md` is authoritative for its shape. Two fields the frontend must render prominently:

- `accuracy.falsePositiveMatches` — displayed **next to** the match rate, never in a separate tab.
- `coldStart.matchRatePct` — displayed as a paired figure whenever `aliasLearning.humanCorrectionsToDate > 0`.

`409 RUN_NOT_COMPLETE` if the run hasn't finished. `accuracy.precision/recall/f1` are `null` when no ground-truth key exists for the dataset (i.e. user-uploaded files) — the frontend shows "not measurable for uploaded data" rather than a fabricated number.

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
  "sharedExplanationCount": 14
}
```

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
        "scoreBreakdown": { "anchor": 0.45, "amount": 0.00, "date": 0.12, "counterparty": 0.04 },
        "rejectedBecause": "amount delta ₹412.00 exceeds band ₹100.00",
        "preview": { "externalId": "SBIN0R52…", "amountDisplay": "₹822.50", "txnDate": "2026-08-16" } }
    ],
    "anchorStrength": "strong",
    "aliasesAttempted": [],
    "windowUsed": { "amountBandPaise": 10000, "dateWindow": [-1, 3] }
  },
  "detectedByRule": "CLASSIFY_AMOUNT_MISMATCH_V1",
  "ruleVersion": "1.0.0",
  "relatedRecords": [ "…TransactionDetail-lite objects…" ],
  "auditEntryCount": 7
}
```

`rejectedBecause` is generated by the **rule engine**, not the LLM — it is the deterministic answer to "why didn't this match," and it renders even when the explain layer is disabled or the API key is absent.

### `ReviewItem` (endpoint 9)

```json
{
  "matchId": "…", "tier": "fuzzy", "confidence": 0.7420,
  "scoreBreakdown": { "anchor": 0.25, "amount": 0.30, "date": 0.15, "counterparty": 0.042 },
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
| Export for the demo | 19 |
| Deploy check | 1 |

No orphans in either direction.

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
- Bulk alias import — **flagged**; may be worth it on Day 9 purely to seed the demo, decide then.
- `DELETE` on anything — the system is append-only by design; revocation is a status change.
