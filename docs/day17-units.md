# Day 17 units — the backlog, split into commits

Companion to [day17-backlog.md](day17-backlog.md). That file says **what is wrong**; this file says
**what we commit, in what order, and what each commit can break that an earlier one fixed.**

Written 2026-09-02, Day 17. Submission **2026-09-05**.

**Working agreement:** one unit → one branch → one self-contained commit → manual test → merge.
Nothing is merged without Tejas clicking it. Units are sequential; the overlap table below names
every unit that re-opens an earlier unit's ground, so a re-test can be targeted rather than total.

---

## The unit list

| # | Unit | Source | Touches API? | Model | Est. |
|---|---|---|---|---|---|
| **Phase 0 — the numbers must be right** ||||||
| **F1** | Run isolation across navigation | item 1 | no | Sonnet/high | 45 m |
| **F2** | Commit a second dataset + its answer key | item 2.1 | no (data) | Sonnet/high | 30 m |
| **F3** | `datasetSeed` is honoured; unknown seed → 400 | item 2.2–2.3 | **yes** | Opus/med | 60 m |
| **F4** | Score every committed dataset, post the reports | item 2.4 | no (op) | — | 20 m |
| **F5** | Pending review: frozen headline vs live count | item 3 | no | Sonnet/high | 30 m |
| **F6** | Nullability audit: `types/api.ts` vs the database | item 3 | maybe | Sonnet/high | 60 m |
| **Phase 1 — behaviour, then verification by clicking** ||||||
| **F7** | A closed exception shows who closed it and why | item 4 | no | Sonnet/med | 30 m |
| **F8** | Closed exceptions vs `/matches` — decide and state it | item 5 | no | Sonnet/med | 30 m |
| **F9** | Exercise the alias learning loop end to end | item 6 | no (writes) | Sonnet/high | 60 m |
| **F10** | Click-test "Run It Again" | item 7 | no | Sonnet/med | 20 m |
| **F11** | Investigation poller: ticking counter + auto-transition | loose | no | Sonnet/med | 30 m |
| **F12** | Retire the `phase4-free` run | loose | no (data) | Sonnet/med | 20 m |
| **Phase 2 — how it reads in 30 seconds** ||||||
| **F13** | Tile labels: "Cold Start" and "Ceiling" | item 8a | no | Opus/med | 30 m |
| **F14** | Copy pass: standfirsts ≤10 words, no repo vocabulary | item 8b | no | Opus plan / Sonnet exec | 90 m |
| **F15** | The Analyst's suggestion replaces the templated one | item 9 | no | Sonnet/high | 45 m |
| **F16** | The Analyst's prose gets its own typographic voice | item 10 | no | Opus/med | 60 m |
| **F17** | Soften the Ask-Analyst confirmation | item 11 | no | Sonnet/low | 20 m |
| **F18** | Dashboard: throughput + accuracy + exceptions above the fold | item 13 | no | Opus/med | 75 m |
| **F19** | Prominent run-a-fresh-dataset control at the top | item 12 | no | Sonnet/high | 45 m |
| **Phase 3 — production credibility** ||||||
| **F20** | Real deployment numbers, with the date measured | item 14 | no | Sonnet/med | 45 m |
| **F21** | Footer disclaimer | item 15 | no | Sonnet/low | 20 m |
| **F22** | Author / contact block — *if time* | item 16 | no | Sonnet/low | 15 m |
| **F23** | Landing motion or imagery — *if time, else cut* | item 17 | no | Opus/med | 45 m |
| **Phase 4 — below the line, cut in this order** ||||||
| **F24** | `reapStaleRuns` — the stale-run reaper | loose / ADR-097 | **yes** | Sonnet/high | 30 m |
| **F25** | Analyst scoring in `tools/score` | loose / §7 | **yes** | Opus/high | 3 h |
| **F26** | Rate limiting behind server-side rendering | loose / ADR-096 | **yes** | Sonnet/high | 45 m |
| **F27** | Deploy web to Vercel (U19) | crit. path 8 | no | Sonnet/med | 60 m |

Phase 0+1 ≈ 6 h · Phase 2 ≈ 6 h · Phase 3 ≈ 2 h · Phase 4 ≈ 5 h.
**Phases 0–2 are the submission. Phase 3 is polish. Phase 4 is what gets cut first**, except F27,
which is not optional.

---

## THE OVERLAP TABLE — read before starting any unit

A unit in the right-hand column re-opens ground the left-hand unit closed. **When we reach it, I
will say so before writing code, and you re-test the earlier unit's behaviour by hand.**

| Closed by | Re-opened by | What could break, concretely |
|---|---|---|
| **F1** run isolation | **F12, F15, F18, F19, F21, F22, F23** | F1 establishes *every `<Link>` carries `?run=`*. Any unit that adds a link can silently drop it, and the failure is invisible — the page renders, it just shows the wrong run. **Re-test: pick the non-default run, click every new control, confirm the URL keeps `?run=` and the masthead run label never changes.** |
| **F1** run isolation | **F3** | F3 makes runs differ. Until then, a dropped `?run=` shows identical numbers and looks fine. After F3, F1's bug becomes visible — which is good, but it means **F1 is not truly proven until F3 lands.** |
| **F3** `datasetSeed` | **F4, F10, F19, F24** | F3 changes what bytes a run reconciles. Every score report predating it is stale. F24 touches the same `routes/runs.ts` run-lifecycle path. **Re-test: `npm run score` on a run of each seed; both must reproduce their own answer key.** |
| **F4** score reports | **F3, F25** | F4's reports are only valid for the code that produced them. F25 changes the scorer itself. **If either lands after F4, re-run F4.** |
| **F5** pending review | **F13, F18** | F5 decides whether the headline shows the run's frozen figure or a live recount, and labels it. F13 rewrites tile labels; F18 recomposes the block those tiles live in. **Both can restore the ambiguity F5 removed.** Re-test: dashboard pending count vs `/review` count, same run, same moment. |
| **F6** nullability | **F3, F15, F20** | F6 aligns `types/api.ts` with `information_schema`. Any unit adding a field re-opens it. Four crashes have already come from a `null` typed as non-null and `tsc` cannot see it. **Re-test: the screen that reads the new field, on a row where it is NULL.** |
| **F7** closure display | **F8** | If F8 concludes a closed exception must surface somewhere else, F7's presentation is the thing that changes. **Sequence F7 → F8 and expect F8 to amend F7, not replace it.** |
| **F9** alias loop | **everything after it** | F9 writes learned aliases to the database. Every later run is then *warm*, and cold/warm rates diverge (ADR-020). A mis-taught alias corrupts every subsequent run and every subsequent score. **This is the only unit in the list whose mistake is not undone by `git revert`.** Re-test: re-score after F9 and confirm precision is still 1.0000 / FP 0. |
| **F12** retire `phase4-free` | — | **HARD PRECONDITION.** Audit entry #728 — the human-resolved exception, the only `human` actor in the audit screen — must be confirmed to live in a run we are *keeping* before `phase4-free` is deleted. CLAUDE.md §10 and what-broke.md both say do not undo it. **First action of F12 is to find which run owns it.** |
| **F13** tile labels | **F14, F18** | F14 is a copy pass over the same surfaces; F18 recomposes them. **Re-test: the two labels still read "Without learned rules" / "Best possible" (or whatever F13 lands on) after both.** |
| **F14** copy pass | **F15, F16, F17, F18, F20, F21** | F14 sets a rule — ≤10 words, no repo vocabulary on visible surfaces. Every later unit writes new visible copy and can break it. **Re-test: read the new copy aloud; any of `reconcilable`, `anchor strength`, `tier attribution`, `provenance`, `implied pairs` on a visible surface is a regression.** |
| **F15** Analyst suggestion | **F16** | F15 decides *what* the Analyst says and where the engine's template goes. F16 decides *how it looks*. They touch the same two files (`[exceptionId]/page.tsx`, `AnalystPanel.tsx`). **Re-test: with no investigation, the engine template must still render — ADR-017's whole argument is that the rules stand without the model.** |
| **F16** Analyst typography | **ADR-098 (locked)** | The provenance vocabulary (`engine` / `measured` / `absent`, `--verified`) is load-bearing and must not be diluted. The Analyst's treatment must be **distinct from**, not a variation on, "measured". **Re-test: put a measured figure and Analyst prose on one screen and confirm a reader cannot mistake one for the other.** |
| **F17** confirmation copy | **F14, F16** | F17's softened wording must still say *this spends live credits*. A later copy pass can shorten that clause away. **Re-test: the confirm panel still states real money is spent.** |
| **F18** dashboard restructure | **F5, F13, F19, F20, F21** | F18 is the largest single regression surface in the list — it recomposes the block that F5's figure, F13's labels and F1's links all live in. **Do F18 before F19/F20/F21, never after.** |
| **F19** top run control | **F1, F10, F18** | Landing on the *new* run's metrics after completion is exactly the `?run=` invariant F1 established, exercised at its hardest. Depends on F1 and F3 being real. |
| **F25** Analyst scoring | **F4, and every published Analyst claim** | F25 creates numbers that do not exist today. Until it lands, "feature-complete and plumbing-verified" is the only honest claim, and the submission must say so. |
| **F26** rate limiting | **F1, F19, everything demo-facing** | Renders are server-side, so the API sees one IP. Changing the keying can lock out the very demo we are polishing. **Re-test: two browsers, both browse freely.** |

### Standing rules that outrank every unit

1. **Every unit that touches `apps/api` ends with `npm run score -- --run <id>`** and the number
   goes in `what-broke.md`. Exit 2 is a build blocker. (CLAUDE.md habit 0.) That is F3, F24, F25,
   F26 — and F9, because it changes the alias state a run reads.
2. **Never change a parameter because the score moved** (ADR-027). Structural fixes only.
3. **Frontend-only units cannot move the score.** If one does, the unit is wrong, not the score.
4. **Append an ADR whenever a unit makes a decision a later session might reverse** — F3, F5, F8,
   F13, F16, F18 all will.
5. **`what-broke.md` gets a line every day**, blank is not allowed.

---

## Branching

`day17-f<n>-<topic>`, one branch per unit, off `main`, merged after manual test.

```
day17-f1-run-isolation
day17-f2-second-dataset
day17-f3-dataset-seed-honoured
...
```

Alternative if 27 branches is too much ceremony: **one branch per phase, one commit per unit**
(`day17-phase0-correctness`, `day17-phase1-behaviour`, …). Commits stay atomic and individually
revertable; there are four merges instead of twenty-seven. Tejas's call.
