# Day 17 backlog — everything found in the Day 16 manual walkthrough

Written 2026-09-02, end of Day 16. **Self-contained: nothing here needs the session it came from.**
Submission is **2026-09-05**. Read `CLAUDE.md` §10 first, then this.

Every item states what is wrong, why it matters, where the code is, and which model to use.
Model routing follows CLAUDE.md §8 — Sonnet unless the error corrupts a measured number or the
decision is one of taste.

---

## The bar we are actually graded against

Verbatim from the Razorpay AI Buildathon Track 4 page, re-read on Day 16:

> **AI Finance Controller** — Run the books and the cash position.
> Build an agent that closes one finance-ops loop across a 50+ record batch of synthetic data,
> **reporting its match rate and the exceptions it could not resolve.**
>
> **THE BAR:** *Throughput plus measured accuracy plus an honest exception list. One cherry-picked
> match proves nothing.*

**Consequence for the frontend, and it is the organising principle of this whole list:** throughput,
measured accuracy and the exception list must be **at the absolute top, legible in 30–60 seconds**.
Everything below is either serving that or getting out of its way.

---

## P0 — correctness. These are wrong, not merely unpolished.

### 1. Runs are not isolated in the UI, and switching between them silently mixes state

**Symptom:** select `verify` in the run picker, click through to Exceptions — you land on
`phase4-free`'s exceptions. Go back to Dashboard and it says `phase4-free` again, though you never
switched back.

**Cause:** `components/chrome/NavLinks.tsx` renders bare hrefs (`/exceptions`, `/audit`, …) with no
`?run=`. Every screen then calls `resolveRun()` (`lib/run-context.ts`), which falls back to "most
recent completed". The selection only survives links built with `hrefWith(..., { run: runQ })`.

**Fix:** `NavLinks` is already a client component — read `useSearchParams()` and carry `run` onto
every nav href. Then sweep every remaining `<Link>` for the same omission.

> **This is the same defect family as ADR-113** (the exception detail page reading the *resolved*
> run instead of the exception's own). That one was fixed at the entity level; this is the
> navigation level, and it is the more dangerous of the two — **a judge comparing two runs would be
> shown one run's numbers under the other's name.**

**Model:** Sonnet 5 / high. Mechanical, but the invariant fails silently and corrupts a comparison.

---

### 2. Both runs report identical match rates, because they reconciled identical bytes

`phase4-free` and `verify` both read **the same three committed holdout files** — verified: all
three `inputFileHashes` are byte-identical across the runs. So 65.22% / 212 / 874 twice is correct
output, not a bug in the engine.

It is a bug in what the product *implies*: two rows that look like two experiments were one
experiment run twice.

**The real fix is task 7c** — `datasetSeed` is parsed, persisted, serialised, and **used nowhere**
(ADR-103); `readSeedDataset()` always returns `data/fixtures/holdout/`.

**Do it in this order:**
1. `npm run generate -- <seed> <label>` for a second dataset; commit its CSVs and answer key.
2. Make `readSeedDataset()` honour `datasetSeed`, restricted to **committed datasets that have an
   answer key** — a dataset without a key renders two headline tiles as "not measured", which is
   the weaker demo, not the stronger one.
3. Reject an unknown `datasetSeed` with `400`. A field that refuses what it cannot honour is
   honest; one that accepts and ignores is not.
4. Score each committed dataset once (`npm run score … --post`) so every run can show measured tiles.

> **The economics are better than feared and this was measured on Day 16:** a run with
> `llmExplainEnabled:false` still produced **199 of 200 explanations from `llm_cache`**, because a
> signature is a bucketed shape with no record identity in it. A fresh dataset hits the same
> signatures; only genuinely novel shapes cost anything (ADR-111).

**Model:** Opus 5 / medium for step 2's selection rule (it touches what a measured number is
computed over). Sonnet 5 / high for the rest.

---

### 3. Every figure on every screen needs one pass against its source

Nobody has checked, screen by screen, that each number is the number it claims to be. Four
type-level lies have already been found this way (ADR-105, ADR-110, ADR-112), each a crash or a
false claim, and **all four were invisible to `tsc` until the annotation was corrected**.

Run the schema check as a command, not an intention:

```sql
SELECT table_name, column_name FROM information_schema.columns WHERE is_nullable='YES';
```

against `apps/web/types/api.ts`. Then walk each screen and confirm every figure's provenance:
engine (self-reported) vs measured (answer key) vs absent.

**Known live inconsistency to resolve while doing this:** `runs.metrics` is frozen at run
completion (ADR-041), so the dashboard reads **71 pending review** while `/review` and `/matches`
report the live count (now 49, after approvals). Both are correct; both on screen at once is not.
Either label the headline as the run's own frozen figure or recompute.

**Model:** Sonnet 5 / high.

---

### 4. A closed exception shows neither who closed it nor why

`ResolveActions` requires a reason and captures `resolvedBy`. Both are written to the audit log
verbatim. **Neither is displayed.** The closed state renders only:

> *"This exception is closed as human resolved. Reopening is not possible…"*

On a product whose argument is that every decision carries its reason, the one decision a *human*
makes is the one whose reason is invisible.

**Fix:** read the closure from the exception's audit trail (already fetched on that page —
`EXCEPTION_RESOLVED_BY_HUMAN`) and show actor, timestamp and reason.

**Model:** Sonnet 5 / medium.

---

### 5. Resolved and won't-fix exceptions: confirm what should happen to them

Open question, not yet a diagnosis. A closed exception does not appear in `/matches`. That is
**probably correct** — resolving an exception is not asserting a match, and only endpoint 21
creates one — but it has not been confirmed against `schema.md` §8 and `ADR-043`.

Decide, write it down, and make the UI say it either way.

**Model:** Sonnet 5 / medium (Opus only if the answer turns out to change a denominator).

---

### 6. The alias learning loop has never been exercised end to end

Zero aliases have been taught, so `/aliases` is empty, `leverageRatio` is null, and every run is
cold. **The entire warm/cold argument (ADR-020) is unverified in practice.**

Teach one from `/review` — including the `409 ALIAS_CONFLICT_UNCONFIRMED` interlock and the
`wouldAlsoResolve` count — then run again and confirm the warm rate moves and the picker labels it.

**Model:** Sonnet 5 / high. Silent-failure risk: a mis-taught alias corrupts every later run.

---

### 7. "Run It Again" is untested, and run isolation is the thing it stresses

The launcher was built and verified only at the API level (a free run made 0 API calls and produced
byte-identical results). **Nobody has clicked it.** It is also the fastest way to create the second
run that item 1's bug needs — so fix 1 first, then test 7.

**Model:** Sonnet 5 / medium.

---

## P1 — how it reads. The track gives us 30–60 seconds.

### 8. Simplify the language everywhere; move the reasoning into disclosures

Measured on Day 16: the median section standfirst is **21 words**, the worst **33**. That is an
essay under every heading. Two rules, and the second is the one a word-count-only pass would miss:

- **Shorten**: every standfirst to ≤10 words, plain language, no repo vocabulary on visible
  surfaces (`reconcilable`, `anchor strength`, `tier attribution`, `provenance`, `implied pairs`).
- **Disambiguate**: `874 of 920 ingested` was not too long — it was **three words hiding a
  three-term accounting identity**, and the preposition invited the reader to supply *missed*
  (ADR-106). Compressions that create ambiguity are worse than long sentences that do not.

The `basis` disclosure pattern on `Figure` already exists — that is where the detail goes.

**Two labels are opaque and they are in the first 15 seconds:** "Cold Start" and "Ceiling" mean
nothing cold. Probably *"Without learned rules"* and *"Best possible"*, precise term in the
disclosure.

**Model:** Opus 5 / medium for the direction call and the tile labels; Sonnet 5 / medium to execute.

---

### 9. The Analyst's suggestion should replace the templated one, and look different

Today `SUGGESTED ACTION` is engine/template text and reads identically whether or not the Analyst
ran. After an investigation exists, show **the Analyst's own concrete suggestion**, visually
distinct, clearly attributed — dynamic, not templated.

Keep the engine's template visible alongside or behind a disclosure. **The point of ADR-017 is that
the rules stand without the model**; replacing rather than adding would destroy the comparison that
proves it.

**Model:** Sonnet 5 / high.

---

### 10. Make the Analyst's words visibly different from everything else

Right now model prose and engine prose are the same ink. They should not be. Do a short piece of
research on how to signal *importance* and *authorship* typographically — the current design system
already carries the tool for it (`--verified` marks measured figures), so extend the same idea
rather than inventing a second vocabulary.

**Constraint:** the existing provenance rule is load-bearing (ADR-098) and must not be diluted.
Whatever the Analyst gets has to be *distinct from*, not a variation on, "measured".

**Model:** Opus 5 / medium. This is taste, and it interacts with a locked design rule.

---

### 11. Soften the Ask-Analyst confirmation for a judge

Currently: *"This spends roughly $0.05–0.12 of real Anthropic credit."* Accurate, and it reads like
a bill being handed to a stranger.

Keep the confirmation — it must still say **this spends live credits** — but frame it for someone
being shown a demo rather than someone being charged. Tejas can say "yeah, this burns my account"
out loud; the interface should not.

**Model:** Sonnet 5 / low.

---

### 12. A prominent, animated "run a fresh dataset" control at the top

Today the only launcher is at the very bottom under Runs. It should be **visible on open**, attract
the eye, and on completion **land on the new run's metrics** — not the previous run's.

Depends on items 1 and 2: it is worthless until runs are isolated and datasets actually differ.

**Model:** Sonnet 5 / high (Opus 5 / medium if the motion design needs a taste call).

---

### 13. Put throughput, measured accuracy and the exception list at the very top

The bar names three things. The dashboard currently leads with a headline row that covers accuracy
well, but **throughput is in block 4** and the exception list is a link. Restructure so all three
are above the fold.

**Model:** Opus 5 / medium. This is the 30-second argument; it is a composition decision.

---

## P2 — production credibility

### 14. Real deployment numbers on the frontend

Measure against Railway (response times per endpoint, cold-start, run wall-clock) and show them as
stated averages **with the date they were measured**. A performance figure with no measurement date
is the same category of claim this project refuses everywhere else.

**Model:** Sonnet 5 / medium.

### 15. Footer with the disclaimer any production build needs

Synthetic data, not financial advice, no real payment data, an unauthenticated demo. Short.

**Model:** Sonnet 5 / low.

### 16. Author / contact block — *if time permits*

**Model:** Sonnet 5 / low.

### 17. Images or motion on the landing screen — *if time permits, and only if it does not read as AI slop*

**Model:** Opus 5 / medium, or cut. A generic hero image is worse than none.

---

## Loose threads carried out of Day 16

| Thing | State |
|---|---|
| `AskAnalyst` arm → confirm panel | Renders server-side and makes 0 network calls on open. **Never watched render.** |
| Run launcher open state | Same. |
| Investigation auto-refresh | Rewritten twice (ADR-116). Server markup, request reduction and the no-JS fallback are verified; **the ticking counter and automatic transition are not.** |
| `phase4-free` run | A test artifact that became the default run and caused ADR-113. **Consider removing it** so there is one obvious run again. |
| Rate limit is shared | Renders are server-side, so the API sees the Next server's IP. `120/min per IP` isolates nothing between viewers — several judges draw from one bucket. |
| Analyst still unmeasured | `tools/score` does not score it. Offline, $0 of API, and now has 11 persisted investigations to score. |
| `reapStaleRuns` | Still a commented TODO; `STALE_RUN_TIMEOUT_MINUTES` is parsed and enforced nowhere (ADR-097). |

---

## The pattern that produced most of this list

Six defects on Day 16 were found by **a person clicking**, and every one had passed typecheck,
production build, and a guidelines audit:

- a `position: relative` on a `<tr>` made all 50 exception rows open row 50
- `null` is a legal `ReactNode`, so nine blank money cells typechecked
- a function prop across an RSC boundary threw only at runtime
- an unkeyed client component kept state across navigation
- `score_breakdown` is NULL for batch matches — 7 review pages crashed
- a poller owned by the wrong component killed itself on first success

> **AUDIT-4 NEEDS A CLICK-THROUGH SCRIPT, NOT A TYPECHECK.** Every automated gate this repo has was
> green while all six were live. The scripts that find them are: open every route, click every
> control, and compare what the screen says against the API that fed it.
