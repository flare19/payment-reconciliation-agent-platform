# Sonnet queue — six frontend/UX items

**Hand this whole file to a fresh session.** Every figure below was verified against the running
localhost instance on 2026-09-03. Nothing here changes engine behaviour, touches the matching
path, or moves a measured number — if a change starts to, stop and escalate.

## Before you start

- Branch: `day18-judge-blockers` (4 commits ahead of `main`). Branch from it, don't work on `main`.
- Servers should already be up: web `:3000`, API `:8080`, and `npm run score:watch -- --api
  http://localhost:8080 --interval 15` from the repo root.
- **Never run `next build` while `next dev` is running** — the build overwrites `.next/` under the
  dev server and every route starts returning 500. It has happened twice. Stop the dev server,
  build, then restart it.
- Canonical run for checking your work: `f8ec36d7-a653-4071-a578-fe2fbecc7c24`
  (`adr163-holdout`, seed 90210). Load it with `http://localhost:3000/?run=<id>`.
- Read `CLAUDE.md` §4 (invariants) and §5 (naming) first. Two that will bite:
  **all SQL lives in `repositories/`**, and **the frontend fetches only through
  `lib/api-client.ts`**.
- `Figure`'s `provenance` prop is **required** — `engine` / `measured` / `absent`. A number cannot
  render without saying where it came from. Use `measured` only for figures that come from the
  score report.
- Verify each item in the rendered HTML, not just by reading the source:
  `curl -s "http://localhost:3000/?run=<id>" | grep -o "..."`. The browser pane struggles with
  this app's streaming dashboard (ADR-127), so curl is the reliable check.

---

## 1 · Put money on the landing screen — **highest impact**

The dashboard opens in records and percentages. This is the **AI Finance Controller** track; the
audience thinks in rupees. A judge's first question is "how much is unaccounted for?" and the
answer currently appears nowhere on the landing screen.

**Verified figures for the canonical run:**

| | |
|---|---|
| Total at risk | **₹33,07,074.91** across 212 exceptions |
| High-severity subtotal | ₹29,48,147.01 (101 items) |
| Largest single item | ₹4,06,441.50 — `MISSING_IN_GATEWAY`, bank `gbBjF2pd5DHVpJSKOLGXR` |

`amountAtRiskPaise` and `amountAtRiskDisplay` already exist on every exception from
`GET /api/runs/:runId/exceptions`. **Do the money arithmetic server-side** — api-contract §0 is
explicit that the frontend never does currency arithmetic or formatting. If a total is needed,
add it to an API response rather than summing in a component.

Add one tile to the headline row (`components/dashboard/HeadlineRow.tsx`), `provenance="engine"`.
Assert the total in a test so a wrong sum can't ship quietly.

## 2 · Surface measured category accuracy where the categories are shown

The exception list looks equally confident about every category. It should not — the scorer
already knows better, and this is the one place the UI currently over-claims.

**Measured multi-label precision on the canonical run:**

```
AMBIGUOUS_MATCH      P 1.0000   R 1.0000
AMOUNT_MISMATCH      P 1.0000   R 0.7500
DUPLICATE_RECORD     P 1.0000   R 1.0000
MISSING_IN_BANK      P 0.7000   R 0.9333
MISSING_IN_GATEWAY   P 0.2857   R 1.0000   ← the weak one
MISSING_IN_LEDGER    P 0.5385   R 0.9333
UNSPLITTABLE_BATCH   P 1.0000   R 0.5000   ← half the true batches are filed elsewhere
```

Already served at `GET /api/runs/:runId/metrics` →
`measured.classification.multiLabel.perCategory`. Render it beside each category name in
`ExceptionBreakdown` and on the `/exceptions` facet list, with `provenance="measured"`.

**It must render `absent`, not a zero, when no score report exists** — that substitution is the
exact failure ADR-041 exists to prevent. Test both states.

## 3 · Pin the demo run; stop the landing page following the last run

During the judge review a throwaway probe run at 26.89% silently became the site's headline. The
page handled it with total honesty, which is to its credit — but on panel day one stray click puts
a crippled run on the front page.

Pin a canonical run for the default dashboard view, with the existing run selector still available
for everything else. Keep `?run=` working exactly as it does now. Roughly five minutes, and it
protects the whole pitch.

## 4 · Lead the exception list with the money, not the taxonomy

`/exceptions` opens with a category breakdown and a severity split — structural facts — before any
total. Reorder: rupee total and the top three items by exposure first, then the taxonomy. Same
data, controller's ordering. The sort already defaults to "Severity, then money at risk", which is
right; this is about what the page says first.

## 5 · Expose the audit hash chain so tamper-evidence is externally checkable

`GET /api/runs/:runId/audit` returns decisions but no `entryHash` / `prevHash`, so
"tamper-evident" currently rests entirely on the server recomputing its own chain. A reviewer
cannot verify it independently. The README now states this limitation honestly (that was a
blocker fix), so this is an upgrade rather than a correction.

Add the two hash fields to the audit-entry DTO and document the canonical-JSON rule from
`docs/schema.md` so a client can reproduce the chain. **Required test:** recompute the chain
independently from the endpoint's own output and assert the head matches what `/audit/verify`
reports. Without that test this is a claim, not a capability.

Touches the audit layer — read ADR-042 first, and do not write to `audit_log` (append-only, DB
trigger enforced).

## 6 · Two small ones

**Tier panel heading.** "How the Number Was Earned — which rule confirmed each pair the engine
matched" sits above a bar totalling 747 pairs, but that total is unchanged when the match count
collapses (proved with a `fuzzyAutoConfirmThreshold: 0.99` probe: matches fell to 235, the bar
stayed 747). It counts pairs **assembled**, not **confirmed** — as the panel's own footnote
already says correctly. Fix the heading to match the footnote.

**Mobile nav overflow.** At 375px the header cuts off after "Review"; Matches, Aliases and Audit
are unreachable with no scroll affordance. Everything else responds well.

---

## Also worth doing, not in the six

**S7's alias tier shows 0 pairs while the alias card claims 3 decisive records.** Both are true
and nothing on the page reconciles them. The reason is already written in the code — see the
comment at `orchestrator.ts` around the cold counterfactual: *"A counterparty alias cannot make a
Tier 1.5 match — that tier re-runs the Tier 1 exact test, which needs a strong anchor."* The
aliases help through the fuzzy path instead. Put that sentence on the page, and fix the S7 tooltip,
which says "empty on a run with no aliases active" on a run that has two.

---

## Do NOT touch

- Anything under `services/matching/`, `services/classification/`, or `tools/score/`. Those move
  measured numbers.
- `STALE_RUN_TIMEOUT_MINUTES` — real, still unimplemented, and an engine-side job (CLAUDE.md §10).
- The two known-open items in ADR-163's consequences.

## Definition of done for every item

`npm run typecheck` in each affected package · `npm test` in `apps/api` **with
`TEST_DATABASE_URL` set** (without it every integration test silently skips and still reports
"pass, fail 0") · `next build` clean with the dev server stopped · the canonical run still shows
match rate **65.56%**, **212** exceptions, and **5 of 5** identities holding in The Books Balance.
