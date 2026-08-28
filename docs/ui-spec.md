# UI Specification

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4
Status: **Day 3 — binding.** The frontend is built on Day 12 by a session that will not have this reasoning in context. This doc is what stops that session redesigning under time pressure.
Companion docs: [api-contract.md](./api-contract.md) · [schema.md](./schema.md) · [ui-spec fallback plan](#8-degradation-plan)

---

## 0. The one requirement everything else serves

> "A panelist must be able to see the result without reading code."

That sentence sets the whole bar. It is not "the UI should be nice." It is: **a stranger opens a URL and, within about fifteen seconds, understands what this system does, how well it did, and what it refused to guess.**

Two consequences:

1. **No empty state on the landing page, ever.** The deployed app opens on a completed run. A judge who lands on an upload form and a "Run Reconciliation" button will close the tab before finding out that the engine works. The default run is fetched server-side and rendered; the upload flow is a secondary path reached deliberately.
2. **The honest numbers are above the fold, together.** Match rate, false positives, cold-start rate and the published ceiling occupy the same visual block. Splitting them across tabs would let a viewer take the flattering number and leave — which is precisely the behaviour ADR-020 exists to prevent, and it must be prevented in pixels, not only in the API.

---

## 1. Screens

Seven screens. Each maps to endpoints already in the contract; none needs an endpoint that does not exist.

| # | Screen | Route | Endpoints | Purpose |
|---|---|---|---|---|
| 1 | **Dashboard** | `/` | 4, 5, 3 | Landing. Headline metrics, run picker, exception summary. |
| 2 | **Exception list** | `/exceptions` | 6 | **The primary screen.** Filterable, sortable, faceted. |
| 3 | **Exception detail** | `/exceptions/[id]` | 7, 13, 20, 21 | Evidence, explanation, linked records, resolve, manual-match. |
| 4 | **Review queue** | `/review` | 9, 10, 11 | Approve/reject fuzzy proposals, teach aliases. |
| 5 | **Matches browser** | `/matches` | 8, 12 | What *did* match, grouped by tier. |
| 6 | **Aliases** | `/aliases` | 15, 16, 17, 18 | The learning loop, with lineage. |
| 7 | **Audit** | `/audit` | 14, 22, 13 | Whole-run trail, filters, chain verification. |
| — | Record inspector | modal, from anywhere | 12, 13 | Normalized fields + `rawPayload` + per-record trail. |
| — | Run launcher | modal, from `/` | 2, 24 | Upload or seeded run; also lists excluded/rejected rows. |

---

## 2. Dashboard — the fifteen seconds that matter

Vertical order, top to bottom. This ordering is the argument the project is making, rendered.

**Block 1 — the honest headline.** One row, four figures, equal visual weight:

```
  MATCH RATE          FALSE POSITIVES     COLD START          CEILING
  82.4%               5                   74.1%               93.0%
  670 / 813 records   measured vs key     no learned aliases  21 events unresolvable
                                                              by design
```

Notes that are not optional:

- **False positives sits second, not last.** An 82 % rate with 5 wrong matches is worse than 78 % with 0, and the layout must make that comparison unavoidable rather than merely possible.
- **The ceiling is displayed as a peer of the match rate**, not a footnote. It reframes 82.4 % from "not great" to "82.4 against a known maximum of 93" — which is the honest reading and the stronger one.
- **Match rate's denominator is on hover** (`engine.matchRate.denominatorNote`). A percentage whose denominator is not inspectable is not a measurement.
- **If `measured` is `null`** (uploaded files, or the scorer hasn't run), the false-positive tile reads *"not measured against ground truth"* in muted text. It never falls back to an engine figure. A fabricated accuracy number is worse than an absent one.

**Block 2 — tier attribution.** A single horizontal stacked bar: exact / alias / identity / fuzzy / near-anchor / batch / manual / unmatched. This is the "how did it earn the number" answer in one glance, and it is where a sceptical panelist looks second. A bar dominated by fuzzy would be a bad sign, and the chart is honest enough to show it.

**Block 3 — exceptions by category**, sorted by count, each a link into a pre-filtered exception list. Severity shown as colour within each bar.

**Block 4 — throughput and LLM cost.** Engine and wall-clock rates side by side, the per-stage breakdown behind a disclosure, and the scale-benchmark curve as a small sparkline with a link. LLM cost as `3 API calls · 53 cache hits · 22 distinct shapes` — a line that tells an engineer more about the design than a paragraph would.

**Block 4.5 — the Analyst.** Investigations run, verdict distribution as a small stacked bar, and three figures that matter: false-despair recovered, proposal precision as a raw fraction, and **hallucinated resolutions: 0**. That last tile stays on screen even at zero — especially at zero. It is the agent's equivalent of the false-positive tile, and it exists so a viewer can see the agent is held to the same standard as the engine.

Below it, the **Q&A box** with four pre-seeded example questions. A blank text box in a five-minute pitch is a way to lose thirty seconds and discover a question the agent answers badly.

**Block 5 — run picker.** Cold/warm run pairs listed together and labelled, never as two unrelated runs in a list.

---

## 3. Exception list — the primary screen

This screen *is* the product. Build it first, and give it the most attention.

**Layout:** left rail of facet filters (category, severity, status, resolvability, source), main table, no infinite scroll — paginated at 50 with the total always visible. A judge needs to see "65 exceptions" as a bounded, countable set.

**Default sort: severity DESC, then `amountAtRiskPaise` DESC.** A finance controller triages by money at risk, which is why severity is computed from amount (ADR-044) rather than fixed per category. A default sort that buries a ₹5,00,000 mismatch under nine ₹5 ones would waste the whole feature.

**Columns:** severity · category (+ secondary flags as small chips) · source and external id · amount · date · amount at risk · best candidate score · resolvability · explanation (truncated to one line).

**Row affordances:** the explanation is visible in the list, not hidden behind a click. The single most impressive property of this system — that it explains itself in plain English — must be legible while scrolling, not something a viewer has to discover.

**The `sharedExplanationCount` badge** ("this explanation covers 14 exceptions") is shown inline. It is the visible face of the signature-cache design and prompts exactly the question worth being asked in an interview.

**Empty filter results** say which filter is responsible and offer to clear it. Never a bare "No results."

---

## 4. Exception detail — where honesty is demonstrated

Order on the page:

1. **The verdict** — category, secondary flags, severity with its basis (`high · escalated from medium: ₹1,20,000 at risk`).
2. **The plain-English explanation**, with its source labelled `LLM` / `cached` / `template`. Labelling the source is not a technical detail; it is the visible proof that the system works without the LLM.
3. **Why it wasn't matched — the rule-level answer**, rendered as a candidate table: each candidate considered, its score breakdown as four small bars, and `rejectedBecause` verbatim. **This section renders identically when the LLM is disabled**, and the UI must not visually subordinate it to the prose above. The prose is narration; this is the finding.
4. **Special-case renderings** that must not be collapsed into generic text:
   - `searchExhausted` → *"Searched all 4,096 combinations of 12 candidate payments. No subset matches this credit."*
   - `searchBoundExceeded` → *"Stopped on its nodes bound (1,300,000 steps) over 24 candidate payments. Decomposition may exist but was not proved."* — the specific bound named (`pool` / `nodes` / `time`) and its value come from `evidence.searchBoundExceeded`.
   - These are different claims (ADR-038) and the interface says which one it is making.
   - `candidateCapHit` → an explicit note that the candidate list was truncated.
   - `displacedByMatchId` → *"The bank record matched a stronger claim (score 0.95)"*, linking to that match.
5. **Linked records** — the raw source rows, side by side, with differing fields highlighted. Side-by-side raw rows are what makes a reconciliation demo land; a panelist can verify the engine's reasoning with their own eyes.
6. **Actions** — `Resolve` / `Won't fix` (note required) and `Create match manually` (reason required, opens a record picker).
7. **The Analyst panel** — present when an investigation exists for this exception:
   - Verdict and confidence as a **label** (`high`/`medium`/`low`), rendered visually distinct from the engine's numeric confidence. They are different kinds of quantity and must never look like the same widget.
   - The reasoning chain as numbered steps. Each shows the tool called, the **`resultDigest` recorded by the runtime**, and the model's `inference` — in visibly separate fields. That separation is what lets a reader check the reasoning against the evidence rather than against a paraphrase of it.
   - Citations render as chips linking to the actual records. A reader must be able to click through and verify.
   - `groundingFailure` or `budgetExhausted` render as an explicit banner, never as a missing panel. An agent that ran out of room and said so is a feature; hiding it would not be.
   - The proposed action with a single confirm button routing to the existing endpoint (21 / 16 / 20), plus **Decline**. Both write to the audit log.
   - `CONFIRMED_UNRESOLVABLE` gets the same visual weight as a proposal. The agent agreeing that something cannot be resolved is a result, not an empty state — it is the verdict that proves the agent is not a yes-machine.
8. **Audit trail** for this exception, collapsed by default, expanding to the full chronological list. Agent steps appear here too (`actorType: agent`), in the same hash-chained timeline as everything else.

---

## 5. Review queue

One item at a time, not a table. This is a decision-making screen and a table invites bulk-approving without reading — the exact behaviour that poisons a learning loop.

Each item shows the members side by side, the score breakdown, `whyFlagged` in plain English, and the pre-filled alias suggestion with its **`wouldAlsoResolve` count front and centre**: *"Teaching AMZN → AMAZON RETAIL would also resolve 6 other records in this run."* That number is what makes the alias feature legible in a five-minute demo — it converts an abstract learning claim into a concrete, checkable one.

The conflict interlock (ADR-025) renders as an inline warning after a `409`, showing the existing mapping and requiring an explicit *"Replace it"* — never an auto-retry.

---

## 6. Audit screen

Filterable by event type and actor. **Four** actor colours (engine / human / llm / agent) so the mix is readable at a glance — a viewer should be able to see that `llm` appears only in `EXPLANATION_*` events and `agent` only in `INVESTIGATION_*` and `AGENT_*` events, never inside a `MATCH_CONFIRMED_*`. That is ADR-017 and ADR-048's boundary made visible in one screen, and a better answer to "does the model decide anything?" than any paragraph.

**Chain verification is a button**, not a background check: *"Verify audit chain"* → calls endpoint 22 → renders `✓ 4,412 entries verified, chain intact`. Running it live is a stronger demonstration than any description of a trigger, and it takes one click during the pitch.

---

## 7. The demo path

The five-minute video and the panel walkthrough follow one route. Every screen above exists to serve some step of it:

1. Land on `/` — the four honest numbers, the ceiling stated up front.
2. Point at false positives sitting next to match rate. State the thesis: *refusing to guess is the feature.*
3. Tier attribution bar — how the number was earned, not just what it is.
4. Into `/exceptions` — 65 exceptions, sorted by money at risk, explanations visible while scrolling.
5. Open one `AMBIGUOUS_MATCH` — two candidates within 0.03 of each other, engine refused to choose. *This is the moment the engine half of the pitch is built around.*
6. Open one `UNSPLITTABLE_BATCH` with `searchExhausted` — the engine proved the decomposition doesn't exist.
7. **The Analyst moment.** Open an `UNSPLITTABLE_BATCH` where the engine reported `searchBoundExceeded` instead, and walk the investigation: the agent noticed the engine stopped on a pool cap rather than a proof, widened the search *using the engine's own subset-sum code*, and found a unique six-payment decomposition. State the principle plainly — **the agent chose which question to ask; deterministic code computed the answer.**
8. Show one `CONFIRMED_UNRESOLVABLE` investigation, then the `hallucinated resolutions: 0` tile. The agent does not resolve everything, and it is measured on that.
9. Ask the Q&A box one seeded question; click a citation through to the underlying record.
10. Into `/review` — teach one alias, show `wouldAlsoResolve: 6`.
11. Show the cold/warm pair and the leverage ratio: *9 corrections resolved 27 records.*
12. Into `/audit` — verify the chain live, with agent steps visible in the same timeline.
13. Close on the two-block accuracy report: Engine and Analyst, both measured against a key that existed before either ran.

---

## 8. Degradation plan

Day 12 is one day for seven screens. **Decided now, in advance, rather than at 2am on Day 12** — because the decision made under time pressure is always to cut the thing that is hardest to finish, which here would be exactly the wrong thing:

| Priority | Screens | If time runs out |
|---|---|---|
| **1 — must ship** | Dashboard, exception list, exception detail | These three *are* the submission. Nothing else is cut before these are polished. |
| **2 — ship plain** | Review queue, audit screen | Functional, unstyled beyond the shared components. |
| **3 — degrade** | Aliases, matches browser | Fall back to read-only tables. Alias *creation* still works from the review queue, which is where it actually matters. |

**Analyst surfaces follow their own order** (agent-design §11), interleaved with the above: the exception-detail Analyst panel ships at priority 1 — it is where the whole layer becomes visible, and without it the agent is invisible to a judge. The dashboard Analyst block is priority 2. **The Q&A box is priority 3 and the first thing cut in the entire frontend** — it is the most demoable piece and the least defensible one, and if something has to go it should be the thing that impresses rather than the thing that measures.

Cut order is bottom-up and non-negotiable. The exception list is never the thing that gets cut.

---

## 9. Conventions

- **All fetches through `lib/api-client.ts`.** One base URL, one error envelope handler, one place where casing is assumed. No `fetch` anywhere else.
- **No client-side money arithmetic or formatting.** The API sends `amountDisplay` pre-formatted (api-contract §0). One formatter, server-side, so the dashboard and the API cannot disagree about a number — which in a reconciliation product would be an embarrassing bug to have on screen.
- **Dates render in IST**, with the UTC instant on hover.
- **Loading states are skeletons, not spinners**, on the dashboard and exception list. A spinner on the landing page during a judge's first three seconds reads as "broken".
- **Every error surface names the failing endpoint** in small text. During a live demo, a failure you can diagnose in five seconds is survivable; an opaque one is not.
- **Desktop-first, 1440px reference.** Mobile is explicitly out of scope (ARCHITECTURE §5) — but nothing may overflow horizontally at 1024px, because someone will open it on a laptop.
