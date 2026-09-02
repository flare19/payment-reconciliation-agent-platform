# Day 17 → Phase 2 handoff

**START HERE if you are a fresh session picking up the frontend polish pass.**
Read `CLAUDE.md` first, then this. Phases 0 and 1 are done and merged into the branch
`day17-fixes` (21 commits, `fc5b78c`…`ef758b0`). **Nothing is merged to `main` yet.**

Submission is **2026-09-05**.

---

## 1. What changed under you, and why the backlog is now partly stale

`docs/day17-backlog.md` was written before any of this. **Where it and this file disagree, this
file is right** — several of its items were fixed, several turned out to be different problems, and
three of its assumptions are now false.

| Backlog said | Reality now |
|---|---|
| item 1 — runs not isolated | fixed (F1). Every `<Link>` carries `?run=`; a guard is *not* in place, so any new link can regress it |
| item 2 — both runs reconcile identical bytes | fixed (F2, F3). Two committed datasets, `datasetSeed` is load-bearing |
| item 3 — figures unchecked against source | done for nullability (F6) and the frozen/live pairs (F5, F30) |
| item 4 — closure invisible | fixed (F7) |
| item 5 — closed exceptions vs `/matches` | decided and documented (F8, ADR-123) |
| item 6 — alias loop unexercised | the loop was **unreachable**; now built, taught, measured (F9, F9.2, F9.3, F9.5) |
| item 7 — "Run It Again" untested | tested (F10); launcher rewritten by F9.4 |
| item 12 — prominent run control | **largely delivered already** by F9.4 — it picks the dataset and cannot spend credit |

**Three assumptions in the backlog that are now false:**

1. *"Teach one alias from `/review`"* — `aliasSuggestions` was a hardcoded `[]`; the whole teaching
   UI was unreachable. Now generated (5 of 49 pending proposals carry one).
2. *"The `409 ALIAS_CONFLICT_UNCONFIRMED` interlock"* — it was declared and thrown nowhere.
3. *"`npm run score` to produce one"* — that string is gone from the UI. `npm run score:watch`
   measures new runs automatically from outside the ADR-021 wall.

---

## 2. The rule that emerged, and it is now load-bearing in four places

> **A frozen figure and a live one may both appear, provided each says which it is.**

- **ADR-119 (F30)** — measured accuracy is reported twice: `ENGINE_ALONE` (invariant after the run)
  and `WITH_REVIEW`, with the human decision count beside it. Approving 22 matches moved recall
  0.6075 → 0.6941 with a byte-identical scorer, and nothing said so.
- **ADR-120 (F5)** — the dashboard's review burden is what the engine *deferred* (frozen); `/review`
  counts what is *still waiting*. Both shown, both labelled.
- **ADR-123 (F8)** — a run's exception total vs how many are still open.
- **ADR-130/132 (F9.2, F9.5)** — cold-start was literally a copy of the warm rate; it is now
  computed by a real second matching pass.

**Phase 2 will render these figures. Do not collapse a pair back into one number to make a tile
fit.** If a layout cannot hold both, the layout changes.

---

## 3. Current measured state — reproduce before trusting any of it

```
holdout (seed 90210)   cold 65.22%  ·  warm 65.56%  ·  212 exceptions
demo    (seed 20260905)     64.61%                  ·  198 exceptions
engine-alone precision 1.0000, FP 0, on BOTH datasets, every honesty gate passed
alias: 1 active (API HOLDINGS → THREPSI SOLUTIONS), touched 6 records, DECISIVE for 3
```

```bash
npm run score -- --run <id> --api http://localhost:8080          # exit 0 = gates passed
npm run score:watch                                              # measures new runs continuously
```

**Local stack** (the API's `.env` points at `recon_test`; the demo data is in `recon_v2`):

```bash
cd apps/api && set -a && . ./.env && set +a \
  && export DATABASE_URL="${DATABASE_URL/recon_test/recon_v2}" && npm run dev   # :8080
cd apps/web && npm run dev                                                      # :3000
```

---

## 4. Phase 2 units, in dependency order

| # | Unit | Note |
|---|---|---|
| **F13** | Tile labels — "Cold Start" and "Ceiling" are opaque | "Cold Start" is already **"Without Learned Rules"**. Re-read the tiles before rewriting: F30/F9.5 changed three of the four |
| **F14** | Copy pass — standfirsts ≤10 words, no repo vocabulary | ADR-106's warning stands: compressions that create ambiguity are worse than long sentences |
| **F15** | The Analyst's suggestion replaces the templated one | Keep the engine template visible — ADR-017's point is the rules stand without the model |
| **F16** | Give the Analyst's prose its own typographic voice | Must be **distinct from**, not a variation on, "measured" (ADR-098) |
| **F17** | Soften the Ask-Analyst confirmation | Must still say it spends live credit |
| **F18** | Dashboard: throughput + accuracy + exceptions above the fold | **Largest regression surface on the list.** Do it BEFORE F19/F20/F21 |
| **F19** | Prominent run control | Mostly done by F9.4; what remains is placement and motion |
| **F20–F23** | Deployment numbers, footer, author block, landing motion | P2 polish |

### Overlaps to warn Tejas about before writing code

- **F1's `?run=` invariant** is re-opened by *any* unit adding a `<Link>` — F18, F19, F21, F22, F23.
  There is **no automated guard**. Re-test by selecting the non-default run and clicking through.
- **F18 recomposes the block holding F5's figure, F13's labels and F1's links.** Before F19/F20/F21.
- **F14's copy rule** is re-opened by F15, F16, F17, F18, F20, F21.
- **F16 vs ADR-098** — the provenance vocabulary is load-bearing; do not dilute it.

---

## 5. Working agreement (unchanged, and it earned its keep)

1. One unit → one self-contained commit → Tejas reviews. Sequential, never parallel.
2. **Warn about overlaps before writing**, so he can re-test the earlier unit by hand.
3. **Every unit touching `apps/api` ends with `npm run score`.** Frontend-only units cannot move it;
   if one does, the unit is wrong.
4. **Watch every guard fail before trusting it** — revert the source, see the test go red, restore.
   This caught real defects nine times in Phase 0/1.
5. Append an ADR for any decision a later session might reverse. **Next number: ADR-135.**
6. Update `docs/what-broke.md` daily. It is a submission artifact.

---

## 6. The four instrument failures, because a fifth is likely

Every one was a *measurement* that was wrong while the code was fine. Two produced confident,
completely false conclusions.

1. **`tail`'s exit code, not the scorer's** — `cmd | tail` reports `tail`'s status.
2. **HTTP 200 from a server component that had thrown** — React removed a whole section and still
   returned 200. **Status is not a correctness probe; check the rendered output and the server log.**
3. **`Object.keys` missing non-enumerable React fibers** — use `getOwnPropertyNames`.
4. **The embedded browser pane cannot complete a streamed response (ADR-127)** — this produced a
   confident "no client component hydrates, it's a P0" diagnosis. **It was entirely wrong.** Tejas
   clicked the button in a real browser and it worked.

> **The rule that earns:** probe 1 in that investigation *was* a known-good control — a sync page
> that hydrated in the pane — which is exactly why the false conclusion survived. **A control that
> differs from the failing case in the very dimension the instrument is weak on proves nothing.**
> Any page that streams (any `async` page component) cannot be interactively verified in the pane.
> **Interactive verification is Tejas's browser, not yours.**

---

## 7. Open, filed, and deliberately not done

| | |
|---|---|
| `leverageRatio` denominator | correct now (decisive, not touched), but `humanCorrectionsToDate` counts superseded+revoked aliases, so it reads 1 on a ledger with 3 rows from interlock testing |
| Alias ledger has a junk row | `WRONG TARGET` (superseded) from F9.3's live test. Endpoint 17 correctly refuses to revoke a superseded alias |
| **Runs cannot be deleted** | ADR-134. `audit_log` is append-only and `audit_chain_heads.run_id` is RESTRICT — both measured. Picker shows 5 of 20 with "show all" |
| A clean demo DB | The only way to a short run list. **`verify` and `phase4-free` hold every human action** — 24 decisions, 3 closures, the only rejection, and the alias supersession chain. Re-do them deliberately or keep those two |
| F11's ticking counter | markup verified at $0; the tick and auto-transition need a real browser. Recipe in `what-broke.md` |
| Analyst scoring | still unmeasured. `tools/score` does not score it. **Do not describe the Analyst as working in the submission** |
| `reapStaleRuns` | still a commented TODO; `STALE_RUN_TIMEOUT_MINUTES` enforced nowhere (ADR-097) |
| Deploy web to Vercel (U19) | untouched. Railway API is live but its DB has **no score reports** — run `npm run score:watch --once --api <railway>` before the video |

---

## 8. The pattern this project keeps finding, now seven times

**A field parsed, documented, published — and enforced nowhere.** `datasetSeed`,
`AGENT_MAX_COST_USD_PER_RUN`, `STALE_RUN_TIMEOUT_MINUTES`, `aliasSuggestions`,
`ALIAS_CONFLICT_UNCONFIRMED`, `counterpartyResolutions`, and the `Alias` type's `createdAt`/`note`/
`timesApplied` — three fields the API has never sent, which crashed `/aliases` the moment an alias
first existed.

**The missing test is identical every time: assert the field CHANGES something.** A test that it is
read correctly passes on all seven.

> **A converse audit is filed for AUDIT-4 and is the cheapest place to find the eighth:** F6's
> nullability pass compared fields the API sends as `null` against types forbidding null. A field
> **entirely absent** from the response never enters that set. `absent ≠ null`. For every field a
> type declares, assert the API actually sends it — and separately, nine declared `ERROR_CODES`
> could not be proven reachable by a naive search.
