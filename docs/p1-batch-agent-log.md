# P1 batch run log

Base branch: day4-dedupe-and-identity
Working branch: fix/p1-batch (local only — see access note below)
Started: 2026-08-27 (unattended scheduled run)

## Summary

| # | Result | Commit |
|---|---|---|
| 1 | FIXED | `60fc5ef` |
| 4 | FIXED | `7badcdd` |
| 3 | FIXED | `49a1f2e` |
| 6 | FIXED | `ae382a1` |
| 2 | FIXED | `f5c4a86` |
| 8 | FIXED | `788170e` |
| 5 | FIXED | `88a6966` |
| 7 | FIXED | `458cbc3` |

8/8 fixed, in the fixed execution order (§2 of the run prompt), zero failed
attempts. `npm run typecheck` clean and `npm run test:unit` green after every
single commit (183 -> 199 tests as coverage was added alongside each fix).
Every fix followed the same protocol: write a test, watch it fail against the
unfixed code first, make the smallest change, confirm green, one commit per
issue.

**Not pushed to GitHub** — see the Access note below. All 8 commits exist only
on the local `fix/p1-batch` branch in this container.

## Access note

Setup step 1 requires `git push -u origin fix/p1-batch`. This failed:

```
remote: Claude doesn't have GitHub access to flare19/payment-reconciliation-agent-platform for your organization.
An org admin can install the Claude GitHub App at https://github.com/apps/claude/installations/select_target,
or reconnect GitHub from claude.ai settings to re-link an existing installation
fatal: unable to access '...': The requested URL returned error: 403
```

Confirmed the block is not just the git CLI: `mcp__github__create_branch` also returned
`403 Resource not accessible by integration`. Read access (issue_read) works fine — only
write/push is blocked. User was notified via push notification at the start of this run.

Proceeding with all 8 fixes as local commits on `fix/p1-batch` so no work is lost. Nothing
will reach GitHub until push access is granted.

Baseline before any issue work: `npm run typecheck` clean, `npm run test:unit` — 183/183 pass.

---

## Issue #1 — S10 node budget worst case

**FIXED.** commit `60fc5ef`.

- Reproduced first: added a test with 24 point contributions of ₹10,000 each,
  target 8,000,001 paise, tolerance 0 (`tests/unit/batch-decomposition.test.ts`,
  "the node budget dominates the true combinatorial ceiling..."). It failed at
  the committed budget: `boundHit={"bound":"nodes","value":1000000}`.
- Fix: raised `batchNodeBudget` from 1,000,000 to 1,300,000 in
  `apps/api/src/config/defaults.ts`, which provably dominates the declared
  space's ceiling `Sum(C(24,k), k=0..8) = 1,271,626` (chosen the "stronger"
  option from the issue over just rewriting the docs). Measured the true
  worst case locally: ~1.08M nodes, ~30ms.
- Fixed the now-false "~7ms" / "200k→405k→1M" narrative in `docs/what-broke.md`.
- `docs/adr-log.md` is append-only, and ADR-060 itself (which has the false
  claim and a self-contradictory 200k/1M Decision line) is a past entry —
  did NOT edit it. Appended ADR-063 recording the corrected budget and
  reasoning, plus a Superseded-section line pointing ADR-060 at it. This is
  the same pattern issue #3 will need for the other 8 stale locations.
- `npm run typecheck` clean, `npm run test:unit` 184/184 (183 baseline + 1 new).
- One attempt, no failures.

## Issue #4 — findSplitSettlement subset search

**FIXED.** commit `7badcdd`.

- Wrote 3 new tests reflecting the real spec (subset-size cap as a search cap
  not a pool ceiling; a 4-of-5 candidate split ignoring a distractor;
  anchor-sharing candidates bypassing the window). Verified they fail against
  the old code via `git stash` (3 subtests failed), then restored the fix and
  confirmed all pass.
- Fix: extracted `searchSubsetsInBand` from `searchSubsets` (same DFS, takes
  an explicit `[lo, hi]` band instead of symmetric target±tolerance, so an
  asymmetric inferred-fee band is exact rather than rounded — `searchSubsets`
  is now a thin wrapper, unchanged signature/behaviour for existing callers).
  Added `minSubsetSize` param (default 1) to exclude size-1 solutions (that's
  an ordinary 1:1 match, not a split). `findSplitSettlement` now builds
  candidates from anchor-sharing OR window+counterparty-matching bank
  credits, runs the real search with maxSubsetSize=4/minSubsetSize=2, and
  emits `ruleId: 'SPLIT_SETTLEMENT_V1'`.
- No ADR needed — this brings code in line with the already-documented spec
  (matching-engine.md §8.1), not a new decision.
- `npm run typecheck` clean, `npm run test:unit` 186/186.
- One attempt, no failures.

## Issue #3 — ADR-060 doc sweep

**FIXED.** commit `49a1f2e`.

- Followed steer 1: wrote `tests/unit/adr-060-doc-sweep-guard.test.ts` (pattern
  copied from `truth-leak-guard.test.ts`) scanning docs/*.md (excluding
  adr-log.md and what-broke.md, deliberately) + env.ts + the batch-decomposition
  test file for 250ms/200k/boolean-searchBoundExceeded patterns. Watched it
  fail (3/3) before touching any doc.
- Fixed all 8 non-adr-log locations from the issue's table: ui-spec.md
  (worst one — panelist-facing UI copy), matching-engine.md (x2: node budget
  figure + searchBoundExceeded boolean->object), api-contract.md,
  agent-design.md (bounds + boolean shape), validation-strategy.md,
  deployment.md, apps/api/src/config/env.ts (the "live hazard" default),
  and the test comment. All now say 1,300,000 nodes / 2s valve.
- docs/adr-log.md is append-only — did NOT touch ADR-060's self-contradicting
  Decision/body lines, per the guardrail (holds even though the issue says
  "amend ADR-060"). That correction already lives in ADR-063 + Superseded
  (issue #1's commit).
- `npm run typecheck` clean, `npm run test:unit` 189/189.
- One attempt, no failures.

## Issue #6 — bank-ledger amount doc/code conservative fix

**FIXED.** commit `ae382a1`.

- Followed steer 2 exactly: took the CONSERVATIVE option. Made all 4 doc
  passages (schema.md §5.3.1/§5.4, matching-engine.md §4.3/§7.1) agree with
  the scorer's current arithmetic (amount scored 0, `amountUnavailable: true`,
  not renormalized). Did NOT touch scoring.ts.
- Documented the previously-unstated consequence everywhere: caps a
  bank<->ledger pair at 0.65 (strong<->weak, exactly the review floor) or
  0.55 (weak<->weak, never a candidate).
- Appended ADR-064 (adr-log.md append-only), explicitly recording that
  renormalization was considered and deferred to a human/the holdout run,
  not decided unattended — plus a Superseded-section "clarified by" line
  for ADR-037 (not a reversal).
- Fixed the flagged test fixture in scoring.test.ts: it used a structured
  invoice_no equal on both sides, which is a strong-strong shared anchor
  that S8's identity-resolution would claim before Tier 2 — a path the real
  pipeline can't produce. Replaced with a genuine strong<->weak fixture and
  added a test asserting the exact 0.65/0.55 ceilings.
- `npm run typecheck` clean, `npm run test:unit` 190/190.
- One attempt, no failures.

## Issue #2 — classify.ts canonical ordering fix

**FIXED.** commit `f5c4a86`.

- Wrote 2 new tests reproducing the exact repro from the issue (ledger
  duplicate row 2, surviving ledger row 1, gateway row 1) plus a
  reversed-discovery-order transitivity check. Watched both fail against
  unfixed code: output came out `[l2, g1, l1]` instead of canonical
  `[g1, l1, l2]`, and reversing duplicate order actually changed the
  output (`[l2,l3,g1,l1]` vs `[l3,l2,g1,l1]`) — a real instability, not
  just a theoretical non-transitivity.
- Fix: added `sourceSystem`/`sourceRowNumber` to `DuplicateFinding`
  (dedupe.ts already has the full row at both construction sites, so
  free to populate). classify.ts now builds a `sortKeyFor` map seeded
  from `pool` and extended with every `input.duplicates` entry, and the
  final sort uses that instead of `byId` (which never has excluded
  duplicates).
- Fixed the flagged test (`classify.ts:172` in the issue) that concatenated
  the excluded duplicate back into `pool` to work around the bug — now
  passes `pool: d.pool` exactly as the real pipeline does, and asserts
  canonical order.
- `npm run typecheck` clean, `npm run test:unit` 192/192.
- One attempt, no failures.

## Issue #8 — ClassificationInput scored-candidate channel

**FIXED.** commit `788170e`.

- Found `ScoredCandidate` already defined in types/engine.ts but completely
  unused anywhere — exactly the pre-designed-but-unwired shape the issue
  describes. Confirmed `classify()` has no production caller yet (only
  tests call it), so this really is pure interface/plumbing work, not a
  behavioral regression against a real pipeline.
- Wrote 2 tests: one supplying real `scoredCandidates` data (watched it
  fail first — `candidatesConsidered` stayed 0 even with 2 real candidates
  supplied, since classify.ts ignored the field), one confirming the
  absent-entry default is unchanged (0/[]/false/null).
- Fix: added `ClassificationInput.scoredCandidates?: Map<transactionId,
  RecordCandidateEvidence>`. classify.ts's presence loop now reads
  candidates/candidatesConsidered/candidateCapHit/displacedByMatchId from
  it when present. A null `ScoredCandidate.rejectedBecause` gets a derived
  reason from its own score (never fabricated, never blank) since
  `evidence.candidates[].rejectedBecause` is a required field.
- `npm run typecheck` clean, `npm run test:unit` 194/194.
- One attempt, no failures.

## Issue #5 — settlementDue window fix

**FIXED.** commit `88a6966`.

- Wrote 2 tests, watched both fail against unfixed code: a ledger presence
  exception's `evidence.windowUsed.dateWindow` came out `[-1,3]` (card
  window) instead of `[-1,1]` (ADR-009 gateway<->ledger window).
- Fix: `settlementDue()` now branches on `record.sourceSystem` instead of
  `target` (target is always 'gateway' for bank/ledger records, so it
  couldn't distinguish them — the root cause). Ledger rows now correctly
  reach ADR-009's existing `gateway_ledger` window (a bug fix, no new
  ADR needed). Bank rows get a genuinely new fallback: added
  `dateWindowGatewayLookbackDays: [-1, 1]` to RunConfig/defaults.ts, with
  its own ADR-065 justifying the value (settlement flows forward FROM the
  gateway capture, so there's no settlement SLA to invert — only the
  universal -1 midnight-drift slack, not a 3-day wait).
- Per the issue's requirement, `windowLabel` now names whichever window was
  actually applied (T+1 for the new fallback, not a fabricated T+3).
- Appended ADR-065 + a Superseded-section "extended by" line for ADR-009.
- `npm run typecheck` clean, `npm run test:unit` 196/196.
- One attempt, no failures.

## Issue #7 — MISSING_IN_LEDGER for bank rows

**FIXED.** commit `458cbc3`.

- Wrote 3 tests, watched all 3 fail against unfixed code: a bank row with no
  ledger counterpart got no `MISSING_IN_LEDGER` secondary flag; the same row
  with its gateway leg matched got no exception at all instead of
  `MISSING_IN_LEDGER` as primary; a regex-guard on the stale ADR-037 comment
  still matched.
- Fix: `missingTargetsFor`'s `case 'bank'` now returns `['gateway', 'ledger']`
  (schema.md §8.1 already defined the category this way — only the code was
  wrong). Kept `case 'ledger': return ['gateway']` unchanged — there's no
  MISSING_IN_BANK-from-ledger category.
- Generalized `settlementDue` (touched again, on top of #5's fix) to use
  `pairKind` for the window lookup in every direction except bank→gateway,
  which keeps #5's ADR-065 fallback since ADR-009 still doesn't define that
  direction. The new bank→ledger presence check now correctly resolves to
  `dateWindowBankLedgerDays` [-2,+4] — the window schema.md §5.2 already
  documented as existing "used only when a gateway anchor is missing."
- Fixed the comment's ADR-037 misreading (ADR-037 forbids *scoring* a
  bank<->ledger pair on amount, not reporting presence/absence).
- No new ADR needed — schema.md's taxonomy definition was already correct;
  only code and a comment were wrong.
- `npm run typecheck` clean, `npm run test:unit` 199/199.
- One attempt, no failures.
