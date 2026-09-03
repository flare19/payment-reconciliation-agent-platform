# What Broke

Required submission artifact. **Updated daily from Day 1** — not reconstructed on the final day.
Format: date · what broke · how it was recovered · what changed as a result.

An empty day gets an explicit `—`. A missing day is worse than a boring one.

---

## Day 16 (2026-09-02), latest — the auto-refresh never fired, twice, for two different reasons

Reported: an investigation finished but the page sat on "Investigating now" until it was reloaded by hand.

**Cause one: the poller was owned by the wrong component.** `AskAnalyst` started the investigation and then set an interval to watch for the result. Its own first refresh, three seconds later, made the investigation row exist — so the page swapped `<AskAnalyst>` for `<AnalystPanel>`, `AskAnalyst` unmounted, and **the unmount cleanup I added in Phase 3 to stop the interval leaking killed the only thing driving the page.**

> **A WATCHER OWNED BY THE ACTION IS GUARANTEED TO BE DESTROYED BY THE FIRST CHANGE IT SUCCESSFULLY DETECTS.** The Phase 3 fix was right in isolation — an interval must not outlive its component. Picking the wrong owner turned a correct fix into a stall. The poller now belongs to the running state, so it lives exactly as long as the thing it watches.

**Cause two, found in the browser console while testing cause one: it rate-limited itself.** `router.refresh()` re-renders the whole detail page, which costs about seven API reads. Every three seconds is ~140 requests/minute against a 120/minute ceiling:

```
Rate limit reached for read requests (120 per 60s). Retry in 38s.
```

Every refresh 500'd — so even with the ownership fixed the page would still never have updated, for an entirely different reason. It now polls one endpoint (`GET /api/investigations/:id`) and spends a full refresh only at the moment the status actually changes. Also dropped a redundant read: endpoint 26 already returns full investigation objects, so re-fetching the same row via endpoint 27 bought nothing.

**And the escape hatch needed the thing that might be broken.** The give-up banner offered a button wired to `router.refresh()`. If the automatic check ever fails *because* client JavaScript is not running, a button that needs JavaScript is no fallback. Both states now carry a plain `<a>` to the page's own URL — a full page load, which works when nothing else does.

> **A CONSEQUENCE FOR THE DEPLOYED DEMO.** Page renders are server-side, so the API sees the Next server's IP rather than the viewer's. `120/min per IP` isolates nothing between browsers: several judges on the live site draw from **one bucket**. That is the inverse of the `TRUST_PROXY_HOPS` risk in ADR-096 — there, everyone shared the edge's IP; here, everyone shares the renderer's.

### What is NOT verified, and why

**The auto-update was never observed working end to end.** The browser tooling degraded through this session — `javascript_tool` evaluating against stale documents, then the pane hanging and timing out on scroll — and the test environment was further polluted by deleting `.next` under a browser holding the old chunk URLs, which produces exactly the symptom of "client JavaScript not running". The server-rendered markup, the request-count reduction and the no-JS fallback are all verified; **the ticking counter and the automatic transition are not.** That is the honest state and it is why the fallback link exists.

---

## Day 16 (2026-09-02), latest — a third of the Analyst's citations led nowhere

Reported from a click-through: some Analyst citations landed on the 404 page.

**They were not all transactions.** The grounding gate accepts any id that appeared in a tool result, and the tools return two kinds — `get_transaction` gives transaction ids, `get_exception` and `find_similar_exceptions` give exception ids. On the holdout: **18 transactions, 8 exceptions, 0 unknown.** The panel linked all 26 to `/records/:id`.

So **eight of twenty-six citations 404'd** — on the one element whose entire purpose is letting a reader check a claim against the record behind it. **A citation you cannot follow is not a citation.** Each id is now resolved server-side to its kind first; all 26 reach a live page, verified one by one.

They also stopped rendering as eight hex characters. `record · gbBjF2pd5DHVpJSKOLGXR · bank · ₹4,06,441.50` is checkable. `07f111a4` is not.

### And the 404 page was still telling people the site was half-built

Written during U17, when the dashboard really was the only screen:

> *"The exception list, exception detail, review queue, matches browser, aliases and audit screens are still being built."*

U18 built all six. Nobody came back to this file. So a reader who followed a broken citation was told the exception detail screen did not exist yet — **while looking at it in the previous tab.**

> **A STALE EXPLANATION IS WORSE THAN NONE.** No explanation leaves someone to investigate; a confident wrong one sends them away to wait for something that shipped days ago. Same failure shape as the error boundary blaming the API for a render bug: **a surface certain about a cause it does not know.** Twice in two days, from two different files, both written when they were true.

### One thing the verification itself found

Checking all 26 citations meant 52 requests in a few seconds, which **hit the read rate limit** — `120/min per IP`, ADR-096, working exactly as designed. Not a defect, but worth knowing the shape of: the exception detail page now issues roughly 5–9 requests (exception, investigations, investigation, audit trail, plus one or two per citation). Human browsing will not approach 120/min; a scripted sweep does.

---

## Day 16 (2026-09-02), late — a second run made the agent disappear, and the agent was already invisible

Reported after a manual test: the Ask button appeared on an exception that had *already* been investigated, clicking it said "the page updates itself" and the page never did, and — separately — the Analyst's only presence in the whole product was that one button.

**The first two are one bug.** The exception detail screen derived its run from `?run=` or "most recent completed", then asked endpoint 26 for *that* run's investigations. Correct while exactly one run existed. **I created a second run an hour earlier to verify the Phase 4 launcher**, it became the default, and:

- every exception from the older run reported *"no one has investigated this"* — and offered to spend money on work already done;
- the poll after a real investigation never found it, because it kept looking under the wrong run;
- the dashboard's Analyst block reported Phase A had not run, on a run with eleven investigations.

One coupling defect, three symptoms, **every one of them shaped like the agent not existing**.

`ExceptionDetail` did not expose `runId` at all, so the page had no way to ask the right question. Now it does, and uses it (ADR-113).

> **THE BUG WAS LATENT FROM THE MOMENT THE PAGE WAS WRITTEN**, and invisible until a second run existed. That is precisely the condition task 7c creates on every click — so it would have shipped directly into the feature designed to make runs cheap to create. Nothing in 840 tests covers "two runs exist"; the integration fixtures create exactly one.

**No money was lost this time.** Spend was unchanged at $0.9359 across the whole episode — the second click hit endpoint 25's memoisation and returned the existing verdict for free, which is ADR-109 working. It just had no way to *show* it.

### The agent was invisible, and that is a grading problem rather than a bug

The track asks for an agent. Ours enforces read-only through Postgres, refuses to do its own arithmetic, and runs a grounding gate that rejects verdicts citing things the model never saw. **Its entire presence in the product was one button at the bottom of one page.** A judge with sixty seconds would have concluded there was no agent.

`/analyst` now exists in the primary nav (ADR-114): the loop in four steps, the verdict distribution, every investigation, the cost, and what is not measured — with the caveat beside the metrics rather than below the fold.

**The tool list on it is derived, not transcribed** — built from the tool calls in the persisted reasoning chains, with real counts:

```
find_by_anchor 15 · get_exception 11 · search_transactions 10 · rerun_subset_search 8
find_similar_exceptions 7 · get_transaction 6 · score_pair 2
59 calls across 11 investigations
```

A list copied out of `agent-design.md` would describe a design. This describes behaviour, and on a site whose argument is that its claims are checkable, that is the difference that earns the page.

---

## Day 16 (2026-09-02), night — a type audit that found a live crash in its first minute

After three separate incidents of a hand-written type declaring non-null where Postgres allows NULL, the audit stopped being a good idea and became a command:

```sql
SELECT table_name, column_name FROM information_schema.columns WHERE is_nullable='YES'
```

compared against `apps/web/types/api.ts`. **It found a fourth, and it was already live.**

`matches.score_breakdown` is NULL for 39 of 284 matches — every `exact` match, and **all 7 `pending_review` batch matches, which sit in the review queue.** `ScoreBars` indexed it directly, so review pages **23, 26, 28, 29, 30, 31 and 34** threw `Cannot read properties of null (reading 'amount')`. Seven of forty-nine, reachable by paging, and nobody had paged that far.

**The crash was again the lesser bug.** Four bars reading `0.0000` would have asserted the engine measured each component and found nothing. A batch match comes out of the subset-sum search, not the pair scorer — there are no components. The panel now says so, and says the confidence came from the decomposition instead.

> **FOUR INSTANCES, ONE PATTERN.** `amountAtRiskDisplay: string`, `costUsd: number`, `tokensIn/Out: number`, `scoreBreakdown: Record<…>` — all declared non-null, all nullable in the schema, all a crash or a false claim. **TypeScript named every one within seconds of the annotation being corrected, and none of them before.** This is not a limitation of the language. It is writing down the happy path and calling it a type, and the compiler dutifully believing it.

### Phase 4 measured two things that were better than expected

**A run with the explain layer off made 0 API calls and produced byte-identical results** — 65.22%, 212 exceptions, same audit chain. ADR-017 has always said the model only narrates decisions the rules already made; the launcher is where a viewer can prove that by running it both ways.

**And that free run still showed real explanations — 199 of 200 from `llm_cache`.** The signature is a bucketed shape with no record identity in it, so explanations paid for by an earlier run apply to a later one over different rows. **A free run is not a degraded run.**

That second finding rewrites 7c's economics. The fear was that a freshly generated dataset would cost another explain pass every time; it will not, because the same *kinds* of discrepancy hash to the same signatures. Only genuinely novel shapes cost anything.

### Also fixed

- **The polling interval outlived its component.** `AskAnalyst` armed a `setInterval` and a separate `setTimeout` to cancel it, so navigating away mid-investigation left it refreshing a page nobody was looking at. One `useRef` and an unmount cleanup.
- **The cost quote was wrong in the honest direction.** The button said ~$0.11; the one real investigation cost **$0.0497**. It now quotes the measured range, $0.05–0.12.

---

## Day 16 (2026-09-02), night — the Ask button worked, and the panel could not draw the thing it started

The first real use of the new "Ask the Analyst" button ended on the error boundary:

```
Cannot read properties of null (reading 'toFixed')
```

**The money was fine** — the investigation ran to completion, `NEEDS_EXTERNAL_DATA`, and cost **$0.0497**, less than half the $0.11 the button quotes. What failed was drawing it *while it was still running*.

`startInvestigation` inserts five columns; every column describing a result is written by `concludeInvestigation`. So mid-flight the row reads `cost_usd NULL`, `tokens_in/out NULL`, and `grounding_passed false` — **the column default, not a finding**. `AnalystPanel` had only ever been written against concluded rows, because until today concluded rows were the only ones a human could reach.

> **THE CRASH WAS THE LESSER BUG.** Had the panel survived `costUsd.toFixed(4)` it would have rendered **"Grounding: Rejected"** about a verdict that did not exist yet — a confident, specific, false claim, on the page whose whole subject is not claiming more than the evidence supports. A schema default is not a measurement. Treating one as a finding is the same error as putting an engine figure in a measured tile, and it would have been far harder to notice than a stack trace.

### Third time a type I wrote was a lie, third time it was a runtime crash

`amountAtRiskDisplay: string` was really `string | null`. `costUsd: number` is really `number | null` — **and I had written the reason down myself**, in a comment in this repo: *"NULL on a free-tier key, never 0."* Widening the declaration to match the schema made `tsc` name all three crash sites in one pass, instantly, having been blind to them for as long as the annotation was wrong.

**The compiler is exactly as honest as its annotations.** All three of these were me typing what I hoped rather than what the table says. That is not a TypeScript limitation; it is a discipline failure with a compiler-shaped alibi.

### The error page blamed the API for a rendering bug

`app/error.tsx` printed *"The API is expected at http://localhost:8080/api — check that it is running and that CORS_ORIGIN allows this origin"* **unconditionally**. So a null-property crash inside a React component told the reader to go and check their network configuration. It now shows that advice only when the message looks like a transport failure, and otherwise says plainly that the data arrived and the page failed to draw it.

**An error surface that names the wrong cause is worse than one that names none** — it sends someone confidently in the wrong direction, which is precisely what it did.

Verified by inserting a `running` row directly and loading the page: renders, no crash, no grounding claim, heading in the present tense. Removed afterwards.

---

## Day 16 (2026-09-02), later still — two controls that could not do anything, and someone else's files

**A confirmation banner that followed the reviewer.** ADR-107 moved the review flash out of the keyed card so it would survive the card remounting on success. The parent is not keyed either — that is what makes it work — so the message also survived `?page=` navigation and announced an approval made three proposals ago. **The same defect as the unkeyed card it replaced, one level up: state outliving the event it describes.** Now dismissed twice over: a 4-second timer, and an effect on `pagination.page` so paging away clears it. The flash carries an `id`, because two identical messages in a row are the same string and a `[flash]` effect would not re-run on the second.

**A filter that could never return a row.** `/matches?tier=manual` was empty and structurally always would be: approving a proposal keeps the tier it was *found* at and flips its status, while `manual` is for endpoint-21 matches that are not built. So the one control a reviewer reaches for after approving twenty matches was the one that could never contain them. Endpoint 8 has always accepted `?status=`; **nothing in the frontend used it.** `/matches` now leads with *Confirmed by* — All · Engine confirmed · **You confirmed** · Waiting for you — each with its count.

> **AND THEN THE FIX WAS STILL HALF-WRONG.** The first pass kept the `manual` button and gave it a good explanation. Explaining a dead control is still shipping a dead control. It is gone from the row now, while `alias` stays — and that is the useful distinction: **empty today is a fact worth offering** (teach one alias and it fills); **impossible is a dead control**, and offering it invites the wrong conclusion, that approvals went missing rather than that they live under another heading.

**Removed `WARP.md` and `.github/copilot-instructions.md`** — both untracked, both 217 bytes, both the identical claude-mem placeholder reading *"No context yet"*, left behind by a tool that was evaluated and not adopted. `CLAUDE.md` was checked and is clean.

> **A CONSEQUENCE FOR THE DEMO, not a defect.** `runs.metrics` is frozen at run completion (ADR-041), so the dashboard reads **65.22% and 71 pending** while `/matches` truthfully reports 22 human-confirmed and 49 pending. Both correct; one is the engine's account of itself when it finished, the other is live. **A judge who approves a few and returns to the dashboard sees two pending counts that disagree.** Today's testing moved the queue 71 → 49. Re-run before recording, or say plainly that the headline is the run's own frozen figure.

---

## Day 16 (2026-09-02), later — the review queue showed two totals and could not reach proposal two

Reported from a walkthrough: *"at the bottom it says 1 of 67 proposals but above it says 66 proposals remain. And when I click next, it still displays the same approved message and nothing changes apart from Page {number} of 67."*

Both real, both mine, and they compounded.

**Two totals, one source, one fabricated.** The done screen printed `Math.max(0, total - 1)` — a guess that one fewer remained — directly above a `Paginate` rendering the real `pagination.total`. **66 and 67 on screen at once**, from the same prop.

**Proposal two was unreachable.** `<ReviewCard>` was rendered with **no `key`**. React reconciles by component type and position, so `?page=1 → ?page=2` reused the same instance and the `done` state survived the navigation. Every later proposal rendered as the confirmation screen for the first one; the page number beneath it updated because `Paginate` is server-rendered. That is exactly the *"only the page number changes"* symptom, and it means the queue could not be worked past its first item.

**The done screen was the wrong model anyway.** An approved proposal *leaves* the queue, so "Next" never meant what the control implied. The queue now drains in place (ADR-107): decide, the total drops, the next proposal appears where the last one was, under a one-line confirmation. The flash lives in the parent rather than the card, because the card is now keyed and would erase its own confirmation on success.

### A third class of bug types cannot catch, hit on the first attempt at the fix

The first version of the fix passed `hrefFor={(p) => …}` from the server page into the `'use client'` queue component:

```
Functions cannot be passed directly to Client Components …
  <... item={{...}} pagination={{...}} hrefFor={function hrefFor}>
```

**Functions cannot cross the server-to-client boundary.** React serialises every prop into the RSC payload and a closure has no serialisation. It typechecked cleanly and threw on load.

> **THREE DISTINCT CLASSES IN TWO DAYS THAT `tsc` IS STRUCTURALLY BLIND TO:** `null` is a legal `ReactNode` (blank money cells), `position: relative` on a `table-row` is spec-undefined (every row opened the same record), and a function prop across an RSC boundary is a runtime serialisation rule. **All three compiled, all three built, all three were only findable by loading the page.** The lesson from the row-overlay bug has now paid for itself twice.

**Verified by doing it.** A real approval through the browser: the proposal changed from LENSKART to FLIPKART, all four on-screen counts moved 67 → 66 **together**, the form cleared, and the API agreed — queue total 66, audit entry **#733** `MATCH_APPROVED_BY_HUMAN`.

---

## Day 16 (2026-09-02) — the dashboard could not answer the first question anyone asked it

`874 of 920 ingested`. Tejas read it and asked: *did we miss rows during ingestion, and didn't we decide ingestion has to be lossless?*

**Ingestion is lossless and the numbers prove it** — 920 rows attempted, 920 parsed, **0 rejected**. The 46 are 37 excluded (authorised, never captured — no money moved, so no settlement exists to match) plus 9 non-primary duplicates. All still in the database, all still queryable, removed from a *denominator* rather than from the system. The principle held; the engine honours it; the opinion happens at S0/classification, after reading, and is declared.

**The frontend could not say any of that.** `GET /api/runs/:runId/population` exists for precisely this — api-contract §111: *"Any number with a shrunken denominator invites the question 'what did you take out?' … Excluded is not hidden."* `ui-spec.md` §1 put it on the run-launcher modal; the run launcher was never built; **endpoint 24 shipped with no consumer at all.** It was hidden.

> **THE ENDPOINT WHOSE ENTIRE PURPOSE IS ANSWERING A QUESTION WAS UNREACHABLE FROM THE PLACE THE QUESTION IS ASKED.** Nothing was broken — the API was right, the engine was right, the number was right. The failure was that a defence written into the architecture never reached a surface anyone would meet it on. Both the endpoint-to-screen map in api-contract §4 and my own U18 pass list endpoint 24, and both counted it as *covered* because it existed.

Fixed as `/set-aside` (ADR-106), which shows the subtraction rather than describing it:

```
920   Rows in the three files
 −0   Failed to parse   ← nothing was lost reading the files
920   Read successfully
−37   Nothing to reconcile against
 −9   The same row twice
874   Records the match rate is measured over
```

The `−0` line renders **even at zero, especially at zero** — it is the only place in the product that states ingestion is lossless, and leaving it out would make that a claim the reader has to trust. Same reasoning as the empty `hallucinated resolutions` tile.

### The wording was the defect, and it would have survived a length-only edit

`874 of 920 ingested` is not too long. It is **three words hiding a three-term accounting identity**, and the preposition invites the reader to supply the missing verb — *missed*, *dropped*, *rejected*. It now reads `874 counted · 46 set aside`, and the second half links to the page.

This landed in the middle of a conversation about the frontend being too wordy for a judge with thirty seconds — the median section standfirst measured **21 words**, worst 33. Both criticisms are right and they pull in opposite directions on this one line. **Shortening prose and removing ambiguity are different operations**, and a simplification pass that only counts words would have left this line exactly as it was.

Verified by clicking, per the lesson from the row-overlay bug the night before: dashboard → link → `/set-aside`, all three tabs, and the zero-state on `Failed to parse` reading *"Not one row failed to parse."*

---

## Day 15 (2026-09-01), night — every row of the exception list opened the same record

**The worst defect of the build so far, and it shipped past a typecheck, a production build, a guidelines audit, two screenshots and a text-extraction check.**

Every one of the 50 rows on the exception list opened exception **`cc0b8854`** — the `AMBIGUOUS_MATCH` at ₹999 that happens to be **row 50, the last row of page one**. Clicking row 1 or row 30 or row 47 all landed there.

### The cause, in six lines of CSS I wrote for a nicety

```css
.catLink::after { content: ""; position: absolute; inset: 0; }
.table tbody tr { position: relative; }
```

It was meant to make the whole row clickable through the category link. **CSS 2.1 §9.3.1 leaves the effect of `position: relative` on a `table-row` UNDEFINED**, and the row does not become a containing block. So every `::after` resolved `inset: 0` against the *viewport* instead, each overlay covered the entire page, and they stacked in DOM order — **the last row painted swallowed every click in the table.**

### Why nothing caught it

- **`tsc` was clean.** There is no type error; it is a layout property interacting with a spec-undefined case.
- **`next build` was clean.** Nothing about it is a build concern.
- **The markup was correct.** I had already verified *"distinct row hrefs: 50"* by grepping the served HTML — and every href WAS right. The overlay is what receives the click; the href underneath it is never consulted.
- **The Vercel guidelines pass was clean.** Its anti-pattern list has `<div onClick>`, missing labels, `transition: all`. It has no rule for "absolutely-positioned pseudo-element over a table row", because that is a correctness bug, not a style violation.
- **Two screenshots looked perfect**, because an overlay with no background is invisible.

> **THE ONLY THING THAT WOULD HAVE CAUGHT IT IS CLICKING A ROW AND READING THE URL — AND I NEVER DID.** I verified this screen five ways and every one of them tested the *markup* rather than the *behaviour*. `curl | grep href` proves the links are correct; it cannot prove they are reachable. This is the frontend's exact analogue of the pattern that runs through this whole file: a check that passes on broken code because it asserts the thing next to the defect.

### The verification that actually settles it

`document.elementFromPoint()` at each row's category cell, which measures precisely what a click will hit:

```
row  1  wants 98ba56e…  hits 98ba56e…   ✓
row  2  wants 40b6c7c…  hits 40b6c7c…   ✓
row 11  wants 9a6590f…  hits 9a6590f…   ✓
row 50  wants cc0b885…  hits cc0b885…   ✓
```

plus one real click through the browser: row 1 → `98ba56e8` → *Missing in Gateway*. Before the fix the same probe returned `cc0b885…` for all four.

**The fix removes the overlay entirely.** The link fills its own cell via padding — a `<td>` needs no positioning tricks — and the whole-row target is given up. A smaller click target is a small cost; a click target that silently opens the wrong financial record is not survivable in a demo about not guessing.

Swept the rest of the codebase for the same shape: the only other `position: absolute` rules are `.sr-only` and `.skip-link`, both correct.

---

## Day 15 (2026-09-01), evening — a walkthrough by the person who has not been reading the code

Tejas clicked through the finished frontend and reported six things wrong with it. **Four were not bugs, and the two that were are both worth more than the four.** Writing down which is which, because "the builder walks their own UI" and "somebody else walks it" produce different lists, and this is the only entry in this file generated the second way.

### The one that inverted: "amount at risk ₹999 wherever I click"

It reads as stubbed data. It is the **ambiguity mechanism** (ADR-104).

```
₹999   × 8  →  AMBIGUOUS_MATCH ×6, MISSING_IN_BANK ×2
₹1,499 × 6  →  AMBIGUOUS_MATCH ×6
₹1,199 × 6  →  AMBIGUOUS_MATCH ×6
```

**18 of 22 `AMBIGUOUS_MATCH` exceptions sit on three round price points**, because `planting.ts` *builds* an ambiguity cluster by putting several payments on one price point, one merchant, one day. The shared amount is what makes them ambiguous. Give those records distinct amounts and the engine matches them trivially — the category disappears, and so does ui-spec §7 step 5, the moment the engine half of the pitch is built around.

**It looks wrong for a real reason.** `AMBIGUOUS_MATCH` carries base severity `high` whatever the amount, so all 22 land in the high band; the default sort shows the ₹4L items first and then a long tail of identical small ones. Repeat rate inside the high band is **47.8%**. Nobody scrolling that list would guess the repetition is load-bearing.

> **THE NEAR MISS IS THE ENTRY.** The instruction was to fix it, and the fix was two hours of generator work that would have invalidated the committed answer key, the score report, the deployed fixtures, every figure in Days 9–15 of this file — **and deleted the demo's centrepiece.** It was also textbook ADR-027: changing a generator parameter because a measured artefact looked wrong. That the complaint was aesthetic rather than numeric changes nothing about the mechanism. Investigating before editing cost twenty minutes.

### The one that was real, and made the first one look worse

**All 9 `DUPLICATE_RECORD` exceptions carry `amountAtRiskPaise: null`, and always have** (ADR-105). The frontend rendered that as an empty cell and as the sentence *"Severity high ·  at risk"* — a visible gap mid-clause. Clicking a duplicate showed a blank money box, three cells from a ₹999 that looked equally fake.

The cause is inside one function. `classify.ts:135` looks the amount up in `byId`, built from `pool`. Twenty-five lines above, the same function states the governing fact in a comment — *"an excluded exact `DUPLICATE_RECORD` never enters `pool`"* — and builds a **second map** to work around exactly that for the sort comparator.

> **TWO FACTS, BOTH WRITTEN DOWN, IN THE SAME FILE, BY THE SAME AUTHOR — AND THE BUG IN THEIR CONJUNCTION.** This is the Day 9 `#40` pattern reproduced inside a single function, and it is the fourth or fifth instance in this repo. The author patched the consequence they were looking at and left the one they were not.

**And TypeScript could not have caught it.** The wire type is `string | null`; `null` is a legal `ReactNode`. Widening the type from `string` to `string | null` produced **zero new errors** at four render sites that were all wrong. Only opening the page found it.

Frontend now guards it — `n/a` in the list, *"Not quantified"* plus the reason on the detail page. **Never `₹0`**: a fabricated zero in a money column is the same failure as an engine figure in a slot labelled measured. The engine-side fix is deferred because `amountAtRiskPaise` feeds `severity.ts`, and engine output changes end with a re-score, not a frontend commit.

### The four that were not bugs

- **"Reject expects a particular string?"** No — `requireString` accepts any non-empty text and stores it verbatim as the audit `reason`. Working as designed.
- **"Review is only cosmetic — /matches?tier=manual is empty."** Review works: 2 matches are `human_confirmed`, audit entries #729–730. `manual` is the tier for endpoint 21 (not built, ADR-102); approving a fuzzy proposal keeps `tier: fuzzy` and flips the status. The real gap is that `/matches` filters by tier and not status, so approvals are invisible.
- **"Audit still shows my earlier approvals."** Append-only, trigger-enforced (ADR-015). If they vanished the chain would break. The feature working.
- **"No aliases taught"** — deliberate, and the page says so.

### Two real frontend bugs found the same way

- **"68 proposals remain" above, "69" below.** Both read the same stale prop; the `- 1` was a guess I wrote into the done-screen and never reconciled with the `Paginate` beneath it.
- **Approve, then Next, shows "Approved" again.** `<ReviewCard>` is rendered without a `key`, so React reuses the instance across `?page=` navigation and the `done` state survives. My "Reload to pull the next one" copy was a workaround written around my own bug.

### On spend safety, checked because it was asked

Every mutation the frontend can perform — approve, reject, resolve, verify chain — is **zero-LLM**. The Analyst surfaces are GET-only and render persisted investigations. The batch investigate endpoint is not called from anywhere in the UI. The one automatic call path is `POST /api/runs` → S13 explain (≤6 Anthropic calls, ~$0.03), and nothing in the UI calls it **yet** — task 7c will, on every click. Gating has to land with 7c, not after it.

---

## Day 15 (2026-09-01), later still — U18: six screens, and a third instance of a field that lies by being accepted

All six remaining screens are built: exception list, exception detail, review queue, audit, matches, aliases, plus the record inspector. Typecheck and `next build` clean across nine routes. `apps/api` untouched again.

**The write path is exercised, not assumed.** `POST /api/exceptions/:id/resolve` was run end to end against the live local API: the exception moved to `human_resolved`, **audit entry #728 was appended with the reason verbatim**, and the audit screen's `human` actor filter — which had been empty all day — now returns it. This repo has a long record of guards nobody watched fire; a workflow nobody watched complete is the same defect.

### `datasetSeed` is accepted by the API and used nowhere — the third instance of one pattern

Asked whether the engine can run on fresh data, the answer turned out to be: the generator can, the API cannot, and the API does not say so.

`routes/runs.ts` parses `datasetSeed`, persists it on the run row and serialises it back on every `RunSummary`. `readSeedDataset()` always returns the committed holdout CSVs from a fixed path. **Pass `datasetSeed: 12345` and you get a run labelled seed-12345 that reconciled seed-90210 data.**

> **THIS IS THE SAME DEFECT AS `AGENT_MAX_COST_USD_PER_RUN` AND `STALE_RUN_TIMEOUT_MINUTES`.** Three times now: a field that is parsed, persisted, documented, published to clients — and enforced nowhere. Every one was invisible to a green suite, because the test that exists asserts the field round-trips, and it does. **The missing test in all three cases is the same one: assert that the field CHANGES something.** ADR-103 records the finding; the fix (reject it, or wire it to a second committed dataset) is scheduled after U18.

### Three defects the screens found in themselves

1. **The explanation column was four words wide.** `table-layout: fixed` sizes columns from the first row when nothing declares widths, and what it chose left ui-spec §3's single most emphatic requirement — *the explanation must be legible while scrolling* — rendering as `A bank credit has no matching gateway…`. Fixed with an explicit `<colgroup>` giving that column 44% and clamping to three lines. **It typechecked, built and returned 200 the whole time.** Only looking at it found this.

2. **`The engine looked at 0 records`.** The no-candidates branch printed `candidatesConsidered` unconditionally, and on a record where blocking produced nothing the sentence became an accidental insult to the engine. The two cases are now genuinely different statements: *scored N and none reached the floor* versus *nothing was in range to score*, which is a real distinction and the second one is itself the finding.

3. **Two CSS modules and one route were written to the repository root** instead of `apps/web`, because the Bash tool's working directory persists across calls and two `mkdir && cat >` commands ran from the wrong one. The page 500'd with `Module not found`. Harmless, caught in a minute — but it is the second time today a stale cwd cost a cycle, the first being `npm run build` clobbering the dev server's `.next` twice.

### Two spec deviations, both deliberate, both stronger than what was asked for

- **The record inspector is a route, not a modal** (ADR-101). Three surfaces link to a record — an Analyst citation, a match member, a rejected candidate — and every one of those should survive a middle-click. Every filter, page and selection across all six screens is a query param for the same reason: the demo path in §7 is now a sequence of shareable links, so a click that goes wrong on stage is still one URL away from recovery.
- **Manual match (endpoint 21) is not built, and the screen says so** (ADR-102). It needs a record picker over the whole run, which is a screen rather than a button, and §8's order cuts from the bottom of priority 1. A judge who reads *"these two are the same, the engine just couldn't prove it"* will look for that action; finding nothing reads as an oversight, finding a sentence explaining the gap reads as a decision.

### The Vercel guidelines pass, second run

Over the U18 files. One finding: the three non-auth free-text inputs (`note`, `rejectReason`) lacked `autocomplete="off"`, which invites a password manager to offer to fill an audit-log reason. Fixed. Clean on the rest — no straight quotes in visible text, no `transition: all`, no `outline: none` outside its `:focus-visible` replacement, every input labelled, every async result inside an `aria-live` region, `<select>` carrying explicit `background-color` and `color` for Windows dark mode.

---

## Day 15 (2026-09-01), later — U17: the frontend's first screen, and three places the ui-spec asked for a chart the data cannot draw

The design system and the dashboard are built. Typecheck and `next build` clean, rendered against a real local API on `recon_v2` with a score report posted so `measured` is non-null. Nothing in `apps/api` was touched; the engine and the score report are byte-identical to this morning's.

### Nothing "broke" in the running sense. Three things were WRONG IN THE SPEC, and each would have shipped as a false chart

The ui-spec was written on Day 3, against response shapes that did not exist yet. It is binding on intent and it was not able to check its own arithmetic. All three of these were found by trying to render them (ADR-099):

1. **`identityEstablished` is not a segment of the tier bar.** §2 block 2 lists `identity` among the stacked bar's segments. `tierPairCounts` builds the tier buckets from the internal pairs of every assembled group; `run-metrics.ts` then grafts `identityEstablished` onto the same object as a **separate diagnostic** — it counts S8 verdicts, not pairs. Drawing it as a slice inflates the bar from 747 to 756 and quietly changes every other proportion. **The object it arrives in looks exactly like a tier map, which is the whole reason this was easy to get wrong.** It is now rendered beside the bar, labelled as not-a-tier.

2. **`unmatched` is not a segment either — it is a different unit.** The bar divides **pairs**; unmatched is a count of **records**. A bar cannot divide two units without lying about at least one.

3. **Severity-within-category does not exist in any endpoint.** §2 block 3 asks for severity as colour inside each category bar. Endpoint 5 reports `byCategory` and `bySeverity` as independent distributions and endpoint 6's facets do the same — nothing served says how many `MISSING_IN_LEDGER` exceptions are `high`. Colouring the bars by severity would have meant **inventing the cross-tab**, on the screen whose subject is honesty. Severity is drawn as its own distribution instead.

### The one that matters: the dashboard nearly shipped a self-reported number in a measured tile

ui-spec §2 block 4.5 asks for a **`hallucinated resolutions: 0`** tile, described as the agent's equivalent of the false-positive tile. Per ADR-053 and validation-strategy §7 that is a **measured** figure, from `tools/score`.

Endpoint 26 returns a field with exactly that name. `routes/investigations.ts` sets it:

```
agentMetrics: { ...metrics, hallucinatedResolutions: metrics.groundingFailures }
```

It is `groundingFailures` verbatim — **the same integer under a second name**, self-reported, and on this run it is **3, not 0**.

Rendering it as asked would have been wrong twice over: a ground-truth-shaped claim sourced from the agent's own table (the exact substitution ADR-041 exists to prevent), and a reader concluding the agent invented three resolutions when what actually happened is that the grounding gate **caught** three. Both readings are worse than the truth.

The dashboard now renders the gate's count as an engine figure under its real name — *Grounding-Gate Rejections* — and renders the measured tile as **absent**, because `tools/score` still does not score the Analyst. The tile stays on screen while empty; the absence is the finding.

> **THE PATTERN, AND IT IS THE SAME ONE AS ADR-094's.** A number that is *parsed, named and served* is not a number that is *measured*. `AGENT_MAX_COST_USD_PER_RUN` was parsed, documented and enforced nowhere; `STALE_RUN_TIMEOUT_MINUTES` still is. `hallucinatedResolutions` is the UI-facing instance of the same shape: **a field whose name makes a claim its implementation does not**. Every one of these was invisible to a green test suite, because a test asserts the field is present and populated — which it is.

### A hardcoded count in the page copy, caught by the guidelines pass

A section standfirst read *"…what the explain layer actually spent to write 212 explanations."* Correct today, wrong the next time the engine runs, on the page whose whole argument is that its numbers are checkable. Now derived from `metrics.engine.exceptions.total`. The rule is written at the top of `page.tsx`: **every count in the copy is derived, never typed.**

### What the Vercel Web Interface Guidelines pass found

Run once, at the end, over `app/`, `components/` and `lib/`. Fixed: two straight apostrophes in visible text (`'` → `’`), `role="status"` on static server-rendered content that is not an async update, a missing non-breaking space in the `ms` formatter, missing `touch-action: manipulation` and `-webkit-tap-highlight-color`, and disclosure summaries with no interactive affordance. Passing without change: focus-visible rings, `color-scheme` and `theme-color` in both schemes, skip link, heading hierarchy, semantic tables over ARIA, `tabular-nums`, `text-wrap: balance`/`pretty`, `prefers-reduced-motion`, no `transition: all`, `Intl.*` for every number and date, URL-reflected state (`?run=`), `translate="no"` on identifiers, `min-width: 0` on flex children.

**Two spec deviations, both deliberate and both improvements.** ui-spec §2 puts the match rate's denominator *on hover*; it is a `<details>` disclosure instead, because hover exposes nothing to a keyboard or a touch screen and *"the denominator is inspectable"* is a claim this project cannot afford to make only to people using a mouse. Same for the basis of every measured figure.

### One thing to fix before the demo, not a defect

`ANTHROPIC_API_KEY` on Railway is still a placeholder, so the deployed run's explain layer fell back to templates and **no score report has been posted to the deployed database**. The dashboard therefore renders two of four headline tiles as *"not measured"* on the live URL while showing all four locally. That is the honest behaviour working correctly — and it is also the first impression a judge gets. Posting a score report to the deployed run is a one-command fix and should happen before the video.

---

## Day 15 (2026-09-01) — the deploy is live, and `llmConfigured` had been lying since the swap

The API is up on Railway and **reproduces the local numbers exactly**: 65.22% match rate, 212 exceptions, 21 signatures, a 612-entry audit chain that verifies and is anchored, in 2.4 s. Nothing about the managed environment changed a decision, which is the result ADR-074 wanted from deploying early.

### `/api/health` reported `llmConfigured: false` on a deploy that was calling Anthropic

The first live run's `metrics.llmCost` showed **three `401 invalid x-api-key` failures against Anthropic** — while the health endpoint on the same process reported `llmConfigured: false`. Both statements cannot be true.

`config/env.ts` exports a provider-aware `llmConfigured(env)` helper. `routes/health.ts` did not call it; it inlined `env.geminiApiKey !== null && env.llmExplainEnabled`. The ADR-093 swap moved the provider and updated the helper, and this one call site was missed. `routes/investigations.ts` endpoint 28 had the identical defect, with a message that told the reader to set `ANTHROPIC_API_KEY` while the condition tested the Gemini one.

**Why nothing caught it.** ADR-093 states the argument in full — *"`/api/health` reports `llmConfigured` as a single boolean … a per-surface provider would make 'configured' true while half the system had no key"* — and then the code grew a second, divergent definition of that boolean. The tests build `Env` objects by hand and assert the endpoint's *shape*, never the agreement between two files' answers to the same question. It could only be seen from outside, by comparing two fields of one deployment: a health check and a run's own cost ledger.

**The pattern, and it is the one this repo keeps finding.** Not a wrong line — a *duplicated* one. The defect lived in the conjunction of two files, which is where Day 9's #40 lived, and where Day 13's #54 lived. No document owns a conjunction and no test covers one.

Fixed: both sites now call `llmConfigured(env)`. `deployment.md` §5.4's checklist — which tests this exact field before submission — would have read green on a broken key and red on a working one.

### The public API had no rate limit, on two meters that both bill by usage (ADR-096)

ADR-095 bounded agent **spend** on endpoint 25, and that bound is correct and unchanged. What it does not bound is **request volume**, and it does not cover `POST /api/runs` at all — which spends no LLM money and is the cheapest way to hurt this deployment: unauthenticated, ~1,700 rows and 2.4 s of engine per call, in a loop. Added a tiered per-IP limiter (`routes/rate-limit.ts`): read 120/min, write 60/h, run 10/h per IP behind a 40/h global, investigate 12/h. Every number is derived from a measured per-request cost, not chosen for feeling safe.

**`trust proxy` was the part that would have failed silently.** Railway terminates TLS at its edge, so without `app.set('trust proxy', 1)` every visitor shares the edge's address and therefore **one bucket** — the first judge to browse would have locked out every other judge. A rate limiter that becomes the outage is worse than none, and nothing about its own tests would have shown it.

### A test that passed against the code it was supposed to reject

Per Day 13's rule, every guard was verified by breaking the source and watching the assertion fail. Four mutations: `tierFor` using `startsWith('/api/runs')`, the global cap deleted, refusals recorded in the window, eviction disabled. **Three failed as intended. The fourth passed.**

`refusals are not counted, so a client ignoring its 429s cannot self-extend` advanced the clock by a full window measured **from the last refusal** — which ages the refusals out too, so the bucket reopened either way and the assertion held against a limiter that counts refusals. The window has to be measured from the **admissions**. Corrected, re-mutated, and it now fails as it should.

**This is the sixth instance of the test-that-cannot-fail pattern, and the first one caught before it shipped** — by the mutation step itself rather than by a later audit. Writing the test is not the guard. Watching it fail is.

### A doc that described the deploy it wished for, and two files that repeated it

`deployment.md` §5.3 stated *"Push to `main` → both platforms rebuild automatically. No manual step."* Railway was never configured that way. **ADR-074 — the locked decision — says the opposite**: *"redeployment stays a single manual action, and there is no CI/CD."* The setup follows the ADR; the prose in §5.3 was aspiration written next to execution detail and never marked as such.

Caught only because Tejas said so, after a push to `main` was made expecting a rebuild that was never going to happen. By then §5.3's claim had already been copied into CLAUDE.md as fact — **a false statement propagating into the orientation file every future session reads first**, which is the most expensive place in this repo for one to land.

**The rule this repo already had, and did not apply to itself:** *"If code and docs disagree, the docs are right until an ADR says otherwise."* Here two DOCS disagreed, and the tie-breaker was already written — an ADR outranks a runbook. Nothing checks that. Both files corrected, and the reasoning is now recorded rather than assumed: manual stays correct until after submission, because there is no CI, the frontend means frequent pushes, and a deploy mid-run has no reaper to clean up after it.

### A third bound that is parsed, documented, and enforced nowhere

Asked whether the service should scale to zero to save compute, the answer turned on a config value that does not do what it says. `STALE_RUN_TIMEOUT_MINUTES` is parsed in `env.ts` and listed in `deployment.md` §3 as *"on boot, non-terminal runs older than this are marked failed"*. `reapStaleRuns` is a **commented-out TODO** in `index.ts` and has been since Day 8.

**This is ADR-094's defect shape for the third time** — after `AGENT_MAX_COST_USD_PER_RUN` (parsed, documented in `agent-design.md` §8, enforced nowhere) and `LoopDeps.preflight` (documented as the seam a guard plugs into, with nothing plugged in). A variable that is read and never applied reads as protection at every site that mentions it.

It matters here because the TODO predicted its own consequence: *"a crashed run sits at `matching` forever and the dashboard polls it indefinitely — a failure mode that only shows up in front of an audience, because only then does anything restart."* **Scale-to-zero makes restarts routine**, which is why ADR-097 rejects it until the reaper lands. Doc corrected to say what is true; the reaper is now the top below-the-line item.

Re-scored after all of it: precision 1.0000, FP 0, recall 0.6075, review-queue precision 1.0 over 213, unresolvable recall 1.0, classification macro 0.9286 / 0.8738, match rate 65.22%, zero build blockers — **every cell identical**. 839 tests in `apps/api`, typecheck and build clean.

---

## Day 14 (2026-09-02) — the Anthropic swap, and five defects no test could have found

Six live runs, **$2.83**, and every one of the five defects below was invisible to a green 818-test suite. They are recorded in the order they were found, because the order is the finding.

| Cost | Defect |
|---|---|
| **$0** | The analyst CLI read `GEMINI_AGENT_MODEL` while `LLM_PROVIDER=anthropic`, so a configured-for-Anthropic run would have sent a Gemini model id to the Anthropic API. Caught by `--dry-run`, which is what dry runs are for. |
| **$0.017** | The explain client lost 2 of 3 batches to unparseable JSON. The Gemini client constrained its output with a response schema; the port carried the request and not the constraint, so Sonnet fenced its JSON and `JSON.parse` refused it. |
| **$0.238** | Investigations lost **2 of 2** to prose instead of verdict JSON — after 4–7 real tool calls each, with no bound having bound. Also found: `max_tokens` counts **thinking** tokens, so a turn can spend its whole allowance reasoning and return a half-written verdict. Two causes, one symptom, now distinguished. |
| **$0.232** | The `resultDigest` A3 requires echoed **verbatim** was **1,192 characters**. The one corroboration that reached a verdict was rejected because the model paraphrased what it could not copy. |
| **$1.07** | Shortening the digest to `get_exception#9e73…` made it *look* like a record id, and **6 of 10** investigations cited the checksum. The gate was right to refuse them; the prompt had never said what an id looks like. |

### The pattern, and it is the useful part

```
no matching tool call   10/10   →  #54's join key
digest mismatch                 →  a 1,192-character verbatim echo
citation is a digest     6/10   →  a checksum shaped like an id
grounded                 7/10
```

**Each fix was confirmed not by errors stopping but by the failure signature MOVING.** A fix confirmed by errors stopping is indistinguishable from a suppressed symptom; a fix confirmed by the error changing shape is not. Every layer peeled revealed the next one, and none of them existed until a real model was on the other end — a fake client copies whatever digest the fixture author wrote.

### Two of the five were caused by the previous fix

The digest was 1,192 characters *because* nothing could confuse it with an id. Shortening it made everything confuse it with an id. Neither state was wrong when it was written; the pair was.

**And the digest defect was ours, not the model's.** A3 demanded a verbatim echo of 1,192 characters while separately handing the model the full result in the same message — the digest carried no information the model lacked. A gate that rejects honest work because the token it demanded was impractical to carry is measuring our design, not the model's honesty.

### One defect the audit found in its own fix

`AGENT_MAX_COST_USD_PER_RUN` was parsed in `env.ts`, listed in `agent-design.md` §8, and enforced **nowhere** — `LoopDeps.preflight` was documented as "the seam the spend guard plugs into" and nothing had ever plugged in. Harmless on a free tier; on a prepaid key with auto-reload off it is a balance that dies mid-run. Fixed in ADR-094 — and the first version of that fix granted a spend-refused turn one last "conclude now" call, which spends exactly what the guard just refused. The pre-existing test *"the refused turn must not reach the model"* caught it. **A work bound can afford a final turn because the money is already spent; a money bound cannot.**

### What the swap did not settle

`tools/score` still does not score the Analyst, so proposal precision, false-despair recovered, unresolvable agreement and hallucinated resolutions **do not exist as numbers**. Both `RESOLUTION_PROPOSED` verdicts were produced and grounded and **neither was accepted** — both proposed matching a record the engine had already matched, and the constraint check refused them. That is ADR-053's guard working, not evidence that proposals are correct.

Engine byte-identical across all six runs: 284 matches, 212 exceptions, precision 1.0000, FP 0, recall 0.6075, exit 0.

---

## Day 13 (2026-09-01), later — #52: S13's explain layer had a rule with nothing enforcing it

`schema.md` §10.4's system prompt asks the model: *"Never invent amounts, dates, merchant names, or reference numbers."* Nothing checked. On the one layer whose output a panelist reads directly, that was a request.

**The asymmetry is what made it a P1.** ADR-053 treats a fabricated specific at A3 as a build blocker; S13 relied on the model's cooperation. And the cache made it durable rather than transient — `explanation_cache` is run-independent, so one invented figure would be served to every later run sharing that signature, with `hit_count` making it look well-established.

**Why the fix is five regexes and not a hallucination detector.** S13's *input* provably contains no specifics: ADR-018's signature is bucketed by construction, `buildUserMessage` emits only those buckets, and a test already asserts no long digit run reaches the prompt (ADR-080 consequence 3's privacy claim depends on it). So a rupee figure in the output *did not come from us* — there is no legitimate route by which it could have. The inference is unusually clean, and that is the whole reason the check is affordable.

Rejected, never retried, matching A3. The signature's own `occurrence_count` is exempted **by value**, not by digit length: the holdout's largest is 39, but ADR-045's 100k benchmark will produce signatures covering hundreds, and a rule that only holds at one scale is not a rule. ADR-092.

**Watched failing.** All three driver tests fail on the pre-fix code — `AssertionError: the model text must not be used`.

**Not yet exercised against a live model.** The check is unit- and driver-tested; no run has yet sent it real Gemini output. That happens in the one bounded post-swap verification run, alongside #53, #54 and #55.


## Day 13 (2026-09-01) — AUDIT-3: three P1s, all invisible to 741 passing tests

**AUDIT-3** audited U11–U13 in an isolated session and filed nine issues. The three P1s are fixed and merged (`3546b6f`); six P2/P3 remain open and are queued on a nightly Sonnet routine.

- **#53 — the headline verdict was unreachable.** A3 validated four `proposedAction` variants meticulously. The system prompt named none of them and showed the model one example of the field: `"proposedAction":null`. Twenty live investigations produced zero proposals, and the single attempt died on `schema: proposedAction must be an object`. Three of `agent-design.md` §7's six metrics were structurally 0 for that reason alone. **The defect lived in the conjunction of two correct files** — the gate implemented §3's schema correctly, the loop implemented §3's honesty rules correctly, and no file owned the fact that the schema has to reach the model. Same shape as #40.
- **#54 — the gate was rejecting truthful verdicts.** A3 joined the model's narrative step number to the runtime turn counter. Nothing kept them in sync, and they came apart whenever the model omitted a call from its write-up or one turn made several calls. **13 of the 15 verdict-producing runs on the baseline were rejected by that collision, not by a hallucination.** The grounding-failure count that §7 reads as a prompt/tool signal was mostly counting our own bookkeeping. Now joined on `(tool, resultDigest)` — the digest was always the thing doing the work.
- **#55 — the self-correction tool searched nothing.** `rerun_subset_search` used `unmatchedOnly` where the engine asks whether a record's *bank role* is open, and truncated by row number before `buildBatchPool` ranked. Filed at "26% of the population" from raw counts; measured through `buildBatchPool` it was **a pool of ZERO for all four `UNSPLITTABLE_BATCH` credits**. It returned `exhaustive: true` and told the model, in deterministic prose it cannot check, that this was "a stronger claim than the engine's original one".

### The sixth instance of a test that could not fail

The obvious test for #55 — *"at the engine's own bounds the tool reproduces the engine's verdict"* — **passes on the broken code.** An empty search is trivially exhaustive, so it agreed with the engine's `searchExhausted: true` for the opposite reason. Two answers matching because one is vacuous. It was written, run against the pre-fix source, seen to pass, and replaced with one that asserts the *input*: the tool's searched `stats.poolSize` must equal `buildBatchPool` over S10's population. **Every behavioural fix on Day 13 was verified by reverting the source and watching the new test fail**, with the failure message recorded in the issue.

### An audit conclusion that was wrong, corrected

`docs/analyst-baseline.md` DEFECT 3 concluded from a uniform 10-of-10 failure signature that corroboration's grounding wiring was at fault. **It was not.** The wiring is correct; the join key was the defect, and it was never corroboration-specific — the same failure appears in three investigations. It only *looked* uniform because every corroboration opened with `get_exception(matchId)` → `found:false` (#59) and so desynced at exactly step 1. A fast diagnosis from a clean signature, and wrong. **That section of `analyst-baseline.md` has not yet been corrected.**

### A cost paid deliberately

#53's fix grows the investigation system prompt by **~405 tokens per turn** (2,716 → 4,337 chars), ~10% of the 40,000-token investigation budget over a 10-step run. It makes the token/step bound inconsistency (`analyst-baseline.md` DEFECT 1) worse, and that defect is still **unfiled and unfixed**. An unreachable headline verdict costs more than 405 tokens, but the two bounds must land before any paid run.

---

- **2026-08-23** — —
- **2026-08-24** — — *(Day 2: architecture documentation. Nothing broke; nothing was built.)*
- **2026-08-25** — *(no session. Deliberately **not** a numbered build day: numbering a day nobody worked inflated every subsequent day by one, which is why the count was corrected on Day 4.)*
- **2026-08-26** — **Day 3, first pass: pre-build design review found three structural flaws in the Day 2 architecture. All three were in documentation only — no code existed yet, which is the entire reason the review happened before Day 5 rather than after.**

  1. **Two of the eight exception categories were unreachable.** `AMOUNT_MISMATCH` is defined as "identity established, amounts differ" — but a pair sharing a `payment_id` with a ₹412 discrepancy scored `0.45 + 0.00 + 0.15 + 0.10 = 0.70` in the fuzzy tier, landing in the 0.65–0.849 review band as a *proposed match*. It never reached classification, so the category could never fire. `TIMING_DRIFT` was worse: same anchor, correct amount, nine days late scored exactly `0.85` — the auto-confirm threshold — so the engine would have silently auto-matched settlements three times past their SLA and reported it as a clean match.
     **Recovered by:** a new pipeline stage (S8) that short-circuits pairs whose strong anchors agree. Identity is *established*, not scored — a similarity score answers "are these the same thing", and blending that with a date disagreement lets the calendar cancel out an identity proof. ADR-029.
     **Changed as a result:** [matching-engine.md](matching-engine.md) §6 exists; two regression tests are now mandatory ([testing-strategy.md](testing-strategy.md) §1.4) and both assert the *negative* — that the result is not a match — because the old behaviour produced a plausible number rather than an error.

  2. **Nothing at Tier 2 could ever auto-confirm.** Once fix #1 removed strong-anchor pairs from the fuzzy tier's domain, the remaining weights capped a weak-anchor pair at `0.25+0.30+0.15+0.10 = 0.80`, below the 0.85 threshold. Every fuzzy match in every run would have queued for human review.
     **Recovered by:** rebalanced weights (anchor 0.30 / amount 0.35 / date 0.20 / counterparty 0.15). ADR-030.
     **Changed as a result:** the fix produced a better property than the original design had — a pair with **no shared reference of any kind now caps at 0.70 and can never be auto-confirmed**, at any amount, on any date. That guarantee falls out of the arithmetic rather than a tunable threshold, and it is now one of the four structural defences against inventing a match.

  3. **`ARCHITECTURE.md` did not exist.** Every one of the six Day 2 docs cited it as the scope lock — 23 references across seven files, to §3, §4, §4.4, §4.6, §4.7, §5, §6, §7 and §7.4. The whole doc set hung off a file nobody had written.
     **Recovered by:** authoring it, reconstructing the section numbering the existing references already assumed. ADR-047.

  Also found and fixed: Tier 1's date window contradicted §5.2 and would have failed every T+2 card settlement (ADR-028); the duplicate-detection rule collided with the generator's own `IDENTITY_DESTROYED` class and would have misclassified the dataset's hardest designed case (ADR-034); ground-truth metrics were specified inside `runs.metrics`, a column the API writes, which would have required the API to read the answer key in direct contradiction of ADR-021 (ADR-041); gateway amount was specified to compare against ledger *gross* when the arithmetic requires ledger *net* (ADR-037); and `MISSING_IN_BANK` used the wall clock, so the same dataset would have produced different exception counts in August and September (ADR-039).

  **The honest summary:** the Day 2 architecture read well and was internally wrong in three places that no amount of careful writing would have surfaced. Writing the *algorithm* down — which stage runs when, and what each one hands the next — is what exposed all three within an hour. Twenty ADRs, nothing built yet, and a day spent not writing code that would have needed rewriting on Day 9.

- **2026-08-26** — **Day 3, second pass: read the architecture back against the track's actual problem statement and found it answering a different question.**

  The statement says *"Build an agent that closes one finance-ops loop."* What had been designed was a deterministic rules engine: fourteen of fifteen stages are arithmetic, tie-breaks and rule precedence, and the only AI touchpoint (S13) writes captions for decisions the engine already finalized — with a template fallback that makes the run complete identically when the API is down. Excellent rules engine. Not an agent, and a panel reading the architecture would have seen that in about ninety seconds.

  **The trap in fixing it:** the obvious move is to put the model into the matching path, and that would have destroyed the project's strongest claim. ADR-017 is load-bearing — measured accuracy is only measurable while the rules are deterministic and reproducible. Trading that for the word "agent" would have been a bad deal.

  **Recovered by:** noticing that a real finance team has both a reconciliation *system* and an *analyst* who works the exception queue it produces, and that this architecture had built the first and none of the second. The Analyst (Phase A) runs strictly after S14, reads engine output as finished fact, and cannot modify it. ADR-048…ADR-057, [agent-design.md](agent-design.md).

  **What made it defensible rather than decorative:** the agent chooses which questions to ask, but deterministic code computes every answer — it calls the engine's own scorer and subset-sum rather than doing arithmetic. Its tool registry contains no mutating tool, so it is unable to write rather than trusted not to. A non-LLM gate verifies every citation against tool calls actually made. And it is scored against the same answer key as the engine, attacking the `false-despair rate` that `validation-strategy.md` §5.3 had *already* defined as the engine's honest headroom — so the existing validation harness scores the new layer almost for free. That last part was luck rather than foresight, and worth admitting.

  **What changed as a result:** one genuine conflict, handled openly rather than papered over. ADR-017 explicitly rejected "LLM-proposed aliases in v1", and the Analyst proposes aliases. Rather than quietly building it and leaving the ADR stale, **ADR-055 amends that single clause under four stated conditions** and preserves the rest of ADR-017 intact. The same discipline applied to a safety claim: `deployment.md` §4 asserted there was no user-facing "ask the AI" box and therefore no way for an anonymous visitor to burn quota. The Q&A endpoint makes that false, so the claim is corrected in the same change that breaks it, with rate limits and a kill switch. Leaving either one stale would have been the exact species of dishonesty the project is built to avoid.

  **Cost:** roughly a day and a half of build time, absorbed by pairing the Analyst with the explain layer on Day 11 and its read tools with the classifier on Day 10. That compresses the frontend to a single day and pushes the pitch video to Sep 5 — both now listed as risks in ARCHITECTURE §10 with pre-decided degradation orders, rather than discovered on Sep 4.

- **2026-08-26** — **Day 3, third pass: first code. Scaffold, migrations, parsing primitives, the Tier 2 scorer and assignment. Three things broke, all caught by tests written alongside the code rather than after it.**

  1. **`schema.md`'s audit-immutability trigger would have failed the first time it was exercised.** It raised `OLD.id`, but the `id` and `sequence_no` columns had been consolidated earlier the same day, in the first pass. plpgsql resolves `OLD.<field>` at *trigger execution* time, not at `CREATE FUNCTION` time — so it installed cleanly, passed a migration run, and would have thrown "record OLD has no field id" the first time anyone tried to tamper with the audit log. A tamper-evidence mechanism that only breaks when exercised is worse than none, because you discover it during the demo or never. Found by running the DDL against a real Postgres instead of reading it. **SQL in a design doc is untested code until something runs it.**

  2. **`parseMoney("--5")` returned `500`.** The sign handler consumed one minus, then `STRICT_DECIMAL` still permitted a leading `-`, so the second survived into the regex and the negative was applied twice — flipping back to positive. Not an error: a plausible number, from code written carefully ten minutes earlier. Fixed by making the pattern unsigned. This is exactly the failure mode the money parser exists to prevent, which is the uncomfortable part.

  3. **A tie-break test failed and the code was right.** I had asserted that two candidates with identical scores resolve by canonical file position. They do not — a perfect tie between two rivals for the same slot is the *least* distinguishable evidence possible, and breaking it by row number is picking a winner by accident of file order. The ambiguity guard correctly refused both. The test was rewritten into two: a perfect tie is maximally ambiguous, and the canonical tie-break governs *processing order*, not winner selection. Worth recording because the instinct to "fix" the code to match the test was the wrong instinct.

  **Two challenges from Tejas that changed the work**, both of the form *"you're asserting consistency-by-construction — go verify there's actually only one implementation"*:

  - **Canonical ordering is necessarily defined twice** — `source_rank()` in plpgsql for `ORDER BY`, `SOURCE_ORDER` in TypeScript for in-memory sorting — because SQL cannot call TS. My migration comment said "change both in the same commit", which is a hope rather than a guarantee. Now a test asserts they agree value-for-value, verified to fail when drift is injected.
  - **Postgres 16 vs 17.** I had validated only against a local 17 and *reasoned* that nothing used was version-specific — a claim about the code made by the thing that wrote the code. Ran the full suite against `postgres:16` (16.15) in Docker: clean. `deployment.md` §2.1 now pins Railway to 16 explicitly and carries the repro command, and the Day 12 checklist gains a production-version check.

  Also corrected an earlier overstatement of my own: the ADR-049 claim that `score_pair` runs the engine's own code was **aspirational** when I first described it, because the scorer did not exist yet. It is now real, and `single-scorer-guard.test.ts` enforces structurally that there is exactly one `scorePair`, one `trigramSimilarity`, one edit-distance function, and no score arithmetic anywhere under `services/agent`.

  **Nothing deployed yet.** ARCHITECTURE §7.4 wants a live URL early and that did not happen — the day went into the engine's highest-risk internals instead. Flagged rather than quietly reslotted: deploying is now Day 4's first task, and every day it slips increases the chance of discovering a platform problem late.

- **2026-08-27** — **Day 4: the day count itself was wrong.** Aug 25 had been numbered as a build day despite no session happening, which pushed every subsequent day one ahead — yesterday was logged as "Day 5" when it was Day 3, and today would have been Day 6 rather than Day 4.

  Nothing broke in the code, but the error was in two *submission artifacts* — this file and the ADR log — plus the build plan, so it was worth correcting properly rather than patching the visible instances. Caught by Tejas, not by me.

  **What made it obvious once stated:** dropping the empty day gives exactly **13 working days, Aug 23 → Sep 5, ending on submission day**. The project has always described itself as a 13-day build; the old numbering quietly made it 14 calendar days with a phantom in the middle.

  **What changed as a result.** The build plan was re-slotted rather than shifted by one, because Day 3 turned out to hold three passes — design review, the Analyst, and five code units — which puts the engine's highest-risk internals about a day ahead. That buffer is already spent on the deploy that did not happen. The re-slot also moves the **first honest cold-run number from Day 12 to Day 10**: a measured accuracy figure with two days left to react to it is useful, and the same figure on the final day is only a report.

  The lesson is small and boring: a day counter is state, and state that nobody reconciles against reality drifts. It drifted for four days inside a project whose entire thesis is measuring things honestly.

  **Also Day 4 (unit 6 — dedupe and the identity short-circuit): `dedupe()` returned the matching pool in INPUT ORDER.**

  The duplicate *findings* were fully deterministic — same clusters, same elected primaries, on any input permutation. What was not deterministic was the collection handed to every stage downstream: `pool` came from a `filter()`, which preserves whatever order the caller happened to supply.

  That is worse than it sounds. ADR-032 requires every decision-feeding collection to be canonically ordered, and S4 is the *first* stage — its output is the input to blocking, the tiers, scoring and assignment. Correctness would then have depended on each of those stages remembering to sort, and the one that forgot would not have failed: it would have produced a slightly different, still-plausible match set depending on how the ingestion happened to enumerate rows. Assignment already sorts, so the visible damage today would have been nil, which is exactly why it would have survived until some later stage did not sort and nobody could explain why two runs disagreed.

  **Caught by** the dedupe determinism test asserting that a reversed input yields an identical result — it did not, and the diff was pool order alone. **Fixed by** returning the pool canonically sorted from S4 itself, so no downstream stage has to remember.

  **What changed as a result:** the rule is now "the stage that produces a collection sorts it", not "the stage that consumes one sorts it". Pushing the obligation to the producer means there is one place to get it right instead of one place per consumer, and a new consumer added later inherits the guarantee rather than having to know about it.

  Never shipped — caught before the commit. Recorded because "the tests caught it" is only reassuring if the near-misses are written down too; a log that contains only the failures that escaped would overstate how well the process is working.

  **Also Day 4 (unit 7 — batch decomposition): two locked ADRs contradicted each other, and implementing the spec exposed a third problem.**

  1. **ADR-038 made a 250 ms wall clock a search bound. ADR-032 and `CLAUDE.md` §4.8 forbid `Date.now()` in any decision path.** Both were written on Day 3, three passes apart, and neither noticed the other. A time-bounded search reports `searchExhausted` on a fast machine and `searchBoundExceeded` on a slow one — and those are *different claims about the data*, one saying "no combination exists" and the other "I ran out of room". Which claim the exception list makes would have depended on the hardware the run landed on. It is exactly the failure ADR-039 was written to prevent for dates, reappearing in another stage four passes later. Fixed by ADR-060: the primary bound is a deterministic node budget, and the wall clock survives only as a safety valve.

  2. **The bound model was wrong in a way only visible by running it.** ADR-038 lumped the pool cap, the subset-size cap and the budget together as `searchBoundExceeded`. In practice the depth-first search reaches the size cap on essentially any pool of eight or more — so `searchExhausted` would have been almost unreachable, and *an honesty flag that is almost never true tells a reader nothing*. The fix distinguishes a **declared** limit (the size cap: announced up front, identical for every batch, named in the reason string — searching all of it is a complete answer to the question actually asked) from a **truncating** one (the pool cap discarded eligible candidates; the budget cut the search short). The hardest case the caps permit — a full 24-candidate pool, no solution, zero tolerance — now returns a genuine proof.

  3. **My first node budget was picked from one measured case, not from the declared space, and it eventually bound on an input the caps still allow.** I picked 1,000,000 nodes after measuring one hard fixture. The declared space is actually bounded by Sum(C(24,k), k=0..8) = 1,271,626 — provably, from the caps themselves — and a same-amount, unreachable-target fixture visits close to that ceiling and exceeded the 1,000,000 budget (audit finding F2, 2026-08-27; see ADR-063). Raised to 1,300,000, which provably dominates every input the caps permit, and said so as a proof rather than a measurement. A bound derived from the declared space is stronger than one derived from a hard case that happened to get measured.

  The pattern across all three is the same and worth naming: **the spec was written carefully and was still wrong in ways that only running it could show.** Day 3's design review caught three structural flaws by writing the algorithm down; this caught three more by executing it. Both passes were necessary and neither would have found the other's.

- **2026-08-27 (later)** — **Reversed the deploy-early rule (ADR-061).** Not a failure, but a decision worth recording because it overturns one made on Day 2 and repeated in `ARCHITECTURE.md` §7.4.

  The original argument was that a live URL early is a strong panel signal and removes the most common last-week failure mode. Tejas's counter-argument is stronger at this stage: **deploying a half-built project means being correct in two places at once instead of one.** A cloud deploy is not a copy of the local build — it adds a build environment, injected variables and a managed database, and every one of those must be re-verified after every dependency change, refactor and migration still to come. The cost is paid repeatedly; the benefit accrues once.

  **The risk that was traded away is real and stays on the books:** the first deploy now lands on Day 11 with two days of slack instead of a week. That is acceptable only because the deploy surface was deliberately kept tiny back on Day 2 (two managed platforms, no containers we author, no orchestration), the one-time setup is already written down, and the Render fallback is pre-decided. Recorded here rather than only in the ADR because "we decided not to do the thing the plan said" is exactly the kind of change that is invisible later unless someone writes down that it was a choice.

  **Also Day 4 (unit 9 — the audit hash chain): two latent bugs surfaced, neither in the unit being built.**

  1. **The migration runner's advisory lock never protected anything.** It was acquired *after* `CREATE TABLE IF NOT EXISTS schema_migrations`, and when `runMigrations` was handed a `Pool` rather than a client, every query could land on a different connection — while `pg_advisory_lock` is *session*-scoped. So the lock was taken on one connection and the migrations ran on others. It had been that way since unit 1 and nothing noticed, because until now only one process ever migrated. The moment a second integration test file appeared, two sessions raced on `CREATE TABLE IF NOT EXISTS` — which is **not atomic in Postgres**: both pass the existence check and then collide on `pg_type_typname_nsp_index`. Fixed by pinning one client for the whole operation and taking the lock before any DDL.

  2. **Two integration files sharing one database, running in parallel.** Node's test runner runs test *files* concurrently by default. Both files truncate the same tables between tests, which `testing-strategy.md` §5 describes as a single-writer model — so they cancelled each other. Fixed by serializing test files (`--test-concurrency=1`); at ~1.8 s for 244 tests the cost is nothing.

  Worth recording because both were **invisible until a second consumer appeared.** A lock with one caller and a database with one writer both look correct indefinitely. The general shape — *a concurrency guarantee that has never been concurrently exercised is an untested guarantee* — is the same reason the hash chain's own append path now takes a per-run advisory lock and has a test that runs twelve appends at once, rather than trusting `schema.md`'s "single writer, single process".

  A third, smaller one: an integration assertion compared `'21' !== 21` because I typed `sequence_no` as a string. It is a `BIGINT`, and `db/pool.ts`'s int8 parser converts it to a `Number` (ADR-059) — the fix working exactly as designed, caught by a test that assumed otherwise.

  **Day 4 closed with ten code units, an independent audit, and 270 tests.** The pattern across the day is worth naming, because it repeated in five of the ten units and was not a coincidence: **writing a spec down catches structural flaws; running it catches a different set, and neither pass finds the other's.** Day 3's design review found three unreachable code paths by writing the algorithm down. Day 4 found a wall-clock determinism hole across two ADRs that never noticed each other, a bound model whose honesty flag would have been almost never true, a precedence order that silently downgraded proven money discrepancies, an advisory lock that had never protected anything, and a node budget fifty times tighter than the duration it was meant to represent — all by executing code that read correctly.

  Also worth recording plainly: **three times today a test failed and the code was right.** A tie-break test that contradicted the ambiguity guard, a severity assertion that claimed a cap was doing work when nothing had escalated, and a grounding fixture that cited an id its own context never returned. Each time the instinct was to fix the code. Each time that would have been wrong. A test written minutes after the code it tests is not independent evidence, and treating a red test as automatically the code's fault is how a suite slowly becomes a record of the author's assumptions rather than of the system's behaviour.

- **2026-08-27 (end of day)** — **Second self-audit, scoped to units 9 and 10 only. Fourteen findings, four of them P1 — and every one of the four was a property the commit message had already claimed to have.**

  The audit brief said it out loud: *read the code, not the commit summaries, because those are self-reported by the same agent that wrote the code.* That instruction earned its place. Three commits from earlier today assert, at length and with reasoning, properties the code did not have:

  > "The transaction-scoped advisory lock makes the single-writer assumption **ENFORCED** rather than merely documented."
  > "**Verified the gate cannot fail open.** A sweep corrupts every field in turn and asserts none of them get through."
  > "An unverified citation **never reaches the database**."

  None of those sentences is a lie. Each describes the design accurately. The code implemented most of the design, and the prose described all of it — and the gap between "most" and "all" is where all four P1s lived. This is a specific failure mode of writing code and its justification in the same pass: the justification is written from the intent, and it reads as evidence afterwards.

  1. **The grounding gate — the anti-hallucination layer, the one deterministic thing standing between a model's output and the database — failed open on three of its four action types.**

     `checkSchema` descended into `MANUAL_MATCH` and left `CREATE_ALIAS`, `MARK_WONT_FIX` and `ADJUST_SEARCH_BOUNDS` entirely unvalidated. The constraint pass then compared fields that might not exist, and **`undefined <= 0` is `false`** — so `if (action.poolSize <= 0 …) return 'search bounds must be positive'`, the single check that did exist, *silently affirmed* for every value that was not a positive number. A check written to reject that accepts instead is the exact shape of failing open, in the one file whose header says every check defaults to rejection.

     What came back with `groundingPassed: true, rejection: null`: an `ADJUST_SEARCH_BOUNDS` proposal with all three bounds missing; with `poolSize: NaN`; with `poolSize: 'lots'`; with a pool of a billion and a budget of one day, against ADR-054 ceilings of 64 and 2000 ms that `config/defaults.ts` already held and nothing enforced. And a `CREATE_ALIAS` with no `canonicalValue` at all, which slipped past the self-map guard because `'AMZN' === undefined` is false.

     The accept path spreads the raw action through unchanged, so each of those was what would land in `agent_investigations.proposed_action`, render in endpoint 27, and sit under the button a human presses to route it into endpoint 16 or 21.

     **Why this one matters more than its line count.** ADR-053 makes a hallucinated resolution a *build blocker*, not a metric — because an agent that invents evidence is strictly worse than an engine that stays silent, since it arrives wrapped in a confident reasoning chain. The gate is the entire mechanism behind that claim. A gate with a hole is not a weaker gate; it is a gate that produces confident-looking output nobody re-checks, which is precisely the artifact the track's *"one cherry-picked match proves nothing"* is aimed at.

     **Caught by** reading the constraint function and asking what each comparison does when the field is absent, then running it. **Recovered by** an exhaustive `switch` over `ProposedAction['type']` — a fifth action type is now a TypeScript error rather than a silently unvalidated proposal — with ADR-054's ceilings enforced on the *proposal*, and the superseded constraint check **deleted** rather than left in place. Keeping a weaker copy of a check that already ran is how the first one got trusted.

     **Changed as a result, and this is the part worth carrying:** the test guarding this was called `THE GATE NEVER FAILS OPEN`. It swept seven corruptions — every one of them a top-level field or a `MANUAL_MATCH`. It passed, continuously, while three of four action types were unguarded. **A test's name is a claim about intent, never about coverage**, and a confident name on a partial test is worse than no test, because it stops anyone looking. The sweep now walks every field of every variant, with bad values chosen per field *kind*, plus each field missing entirely — 78 corruptions, and it asserts each well-formed variant *passes* first, so the rejections mean something.

  2. **The tamper-evidence mechanism accusing itself.** The entry hash was computed over the caller's object; the columns were written with `JSON.stringify`. Two serializers, expected to agree by convention, disagreeing in two places: `details ?? {}` coerced `null` to an object the hash never saw, and `JSON.stringify` *drops* an `undefined`-valued key where `canonicalJson` emits `"k":null`.

     So `appendAuditEntry({ details: null })` wrote a row that could not reproduce its own `entry_hash`, and `GET /api/runs/:runId/audit/verify` — the endpoint that exists to prove the log was not touched — reported `entry_altered` on a log nobody had touched. **At the scale this is judged on, that is not one bad row:** the chain is per run and thousands of entries long, so one such entry makes every entry after it unverifiable too, and the failure is silent until someone runs the verifier.

     The unit test that should have caught it asserted `canonicalJson({a:undefined}) === canonicalJson({a:null})` — that the serializer agrees with *itself*, which was never in doubt. The threat was that it disagreed with what the column actually holds. **Recovered by** one `toStoredForm` producing the entry as the database will hold it, with both the hash and the column values derived from it; `computeEntryHash` applies it internally, so hashing a shape the database would not have stored is now unrepresentable. **Changed as a result:** the replacement test asserts the real invariant — a canonicalized value is a *fixed point of a jsonb round trip* — across seventeen shapes.

  3. **`valid: true` on a log that had been cut in half.** A hash chain proves the entries you are holding are consistent. It cannot prove you are holding all of them: delete the last N entries and every survivor still links correctly to the one before it. Five entries, delete two, `valid: true`. Delete a run's entire chain and it was indistinguishable from a run that never logged anything.

     Both existing removal tests deleted an **interior** entry (`OFFSET 1 LIMIT 1`), which `prev_hash` linkage does catch. The tail was never tested because the design had no way to see it — so "drop everything after the decision I want to hide", the cheapest tamper available, was the one the mechanism could not detect. Endpoint 22 is specified to be run **live in front of a finance panel** as proof of immutability; certifying a truncated log as clean is the worst possible thing for it to do.

     **Recovered by** migration 011: an anchor outside the chain holding each chain's `entry_count` and `head_hash`, moved in the same statement as the entry it describes. **Changed as a result:** verification now answers two separate questions instead of conflating them — *are the entries present consistent* and *does the log end where it should* — and the residual is stated rather than hidden. `anchored: false` makes `valid: true` the weaker claim it actually is. Nothing inside one database survives full write access to that database; the honest framing is that this turns a single `DELETE` into two coordinated writes across two tables and gives an auditor a value they can pin externally.

  4. **The same advisory-lock bug, twice, the second time inside the fix for the first.** Recorded earlier today: the migration runner took a *session*-scoped lock on a `Pool`, which hands out a different connection per query, so it protected nothing. The unit that found that then took a *transaction*-scoped lock on a caller-supplied client that need not be inside a transaction — where each statement is its own transaction, so the lock was released by the very statement that took it.

     Twelve concurrent appends on bare pooled clients produced four entries claiming one predecessor and two claiming another, and the verifier reported `chain_broken` on an untampered log. **A tamper-evidence mechanism whose own writer can make it cry tampering is worse than not having one**, and the 12-append test that was meant to prove otherwise exercised only the path that already worked.

     **Changed as a result — and this is the one structural change of the day.** Patching the instance would have left the class intact for a third occurrence, so: a branded `TxClient` that only `withTransaction` can produce, so there is no signature anywhere that lets a transaction-scoped lock be taken somewhere it will not survive; a runtime `pg_locks` check folded into an existing statement, which costs **no extra round trip** — deliberate, because at ADR-045's 100k-record benchmark the audit write path is among the hottest in the system; and one lock registry carrying the post-mortem of both failures, so a third lock gets added next to the reasons.

  **The honest summary.** Day 3 established that writing a spec down catches one class of flaw. Day 4 established that running it catches a different class, and that neither pass finds the other's. Today adds a third: **auditing your own output catches a class that neither of the first two reaches — the drift between what the code does and what its author said it does.** All four P1s were confidently-argued properties that were true of the design and partly true of the code. No test failed. Nothing looked wrong.

  Two smaller things, recorded because leaving them out would flatter the process:

  - **Nothing here was found by running the engine, because the engine still does not run end to end.** It was found by writing adversarial tests against individual units and executing them against a real PostgreSQL rather than reasoning about what PostgreSQL would do. The `jsonb` key-order round trip, the `pg_locks` predicate's behaviour on negative lock keys, and `ON CONFLICT` inference against a `NULLS NOT DISTINCT` index were each verified empirically *before* being relied on. Three of the four fixes depend on a database behaviour that would have been easy to assert confidently and wrongly.
  - **Two of the regression tests written today were wrong while the code was right.** One asserted that `{a:1,b:undefined}` should hash identically to `{a:1}` — it should not, those are two different stored values, and collapsing them is the same failure the NaN guard exists to prevent. The other flagged `rationale: 'lots'` as a fail-open, when `'lots'` is a perfectly good rationale and only a bad `poolSize`. That is five times in two days that a red test was the test's fault, and the Day 4 entry had already named the pattern. Naming a bias does not stop it; it only shortens the time to noticing.

- **2026-08-28 (Day 5)** — **The generator landed in six reviewed units (G1-G6), and the project can measure something for the first time. Two things broke: one silent data bug that eleven rows deep would have corrupted the accuracy number, and one delegation that cost far more than the work was worth.**

  **What the generator now guarantees.** 300 events → 920 records, 21 designed-unresolvable split 9/6/6, ceiling **93.0% computed from the realized data rather than asserted**. The realized scenario distribution matches §3's table exactly, because allocation is largest-remainder rather than sampled — under sampling variance a 3%-weight scenario on 300 events has a standard deviation near 3, which would have made the ceiling quoted in the README, the dashboard and the pitch move every time the seed changed.

  **THE BUG THAT MATTERED, and how it was hidden.** `captured_at` was built as `second + 2` with no carry, emitting `19:47:61`. `parseSourceDate` correctly rejects that, and a rejected row leaves the matching population entirely (ADR-046) — so **eleven of 323 gateway rows would have lost their gateway leg and surfaced as false exceptions**, corrupting the measured accuracy for a reason nothing downstream could see. The G3 invariants could not catch it: they check *typed* values, and this bug exists only in the emitted string. Nothing between the projection and the parser was looking.

  It was hidden by a test that could not fail:

  ```ts
  assert.equal(parseSourceDate(row.valueDate, 'YYYY-MM-DD HH:MM:SS' as never).ok || true, true)
  ```

  `X || true` is always `true`, and the `as never` cast was silencing the type error pointing straight at it. Rewritten as a real round trip — format as the source would, parse with that source's declared format, assert the same calendar day, over ~1,100 date fields — **it failed on the first run**, and that failure was the bug. **Recovered by** real carry arithmetic, and `formatGatewayTimestamp` now throws on an out-of-range time: a formatter that can emit what the parser refuses is a silent-bad-data generator, and the guard belongs at the boundary rather than in a test that might not be written.

  Two more tests in the same batch could not fail: `assert.ok(names.size >= 1)` under a test named *"at least two of the three names differ"* (a `Set` of two strings always has size ≥ 1), and `assert.notEqual(ledgerNet, gatewayAmount)` under one named *"beyond the real tolerance band"* (a one-paisa difference satisfies it). Plus a dead identity function, `pickLedgerDate(_rng, d) { return d; }`, whose nine-line comment claimed the ledger date distribution *"is asserted in project.test.ts"* — where no such assertion existed.

  **This is the fourth time.** Issue #11 found a test that could not fail; the Tier 1.5 guard was written specifically to avoid becoming one; the "THE GATE NEVER FAILS OPEN" sweep turned out to cover a quarter of what its name claimed. The pattern is now well enough established to name as a rule: **a test whose name makes a claim its assertion does not check is worse than no test**, because it converts an unexamined area into one that looks examined. The tell is an assertion that is weaker than the test's own title.

  **THE DELEGATION THAT WENT WRONG.** G6 was handed to Sonnet as planned — mechanical implementation against a spec (the G3 invariants and G4 proofs) that already existed and already ran. It produced working code, and it burned roughly thirty minutes and a large share of a daily allowance without committing anything, so from outside it looked like nothing had landed. The causes are specific and avoidable, and worth writing down because the same delegation is planned again for the engine tiers:

  1. **~2,400 lines read in full before writing a line.** Twelve source files opened end-to-end — `invariants.ts` (336), `answer-key.ts` (331), `proofs.ts` (288), `engine.ts` (261), `events.ts` (238) and more — where targeted greps and section reads would have served. Every subsequent turn re-sends all of it.
  2. **Very large files written in one shot, then debugged serially.** `project.ts` arrived at ~630 lines before its first typecheck. Each fix cycle then paid the full context cost again: apostrophe inside a single-quoted string, `readonly` vs mutable array types, `exactOptionalPropertyTypes`, a missing `csv-parse` dependency discovered only at test time, and a wrapper function plus a bottom-of-file import that had to be unwound across three separate edits.
  3. **Exploratory sweeps after the work was already done** — sixty seeds, then a count sweep, then a cluster-floor probe. Genuinely informative, and none of it was needed to finish the unit.
  4. **Nothing committed.** Six modules and their tests sat uncommitted, which is also why the state was unreadable from outside.

  The cost model is the thing to internalise: **an API request re-sends the whole conversation, so spend scales with turns × context length.** A long context and many short fix cycles is the most expensive possible combination, and it is exactly what "load everything, write big, debug serially" produces. The work itself was maybe six focused turns.

  **What changes as a result.** Delegation instructions now say: read by grep and section, not by whole file; write and typecheck ONE module at a time; commit each module as it passes; do not run exploratory sweeps unless the unit's acceptance criteria require them. And the model routing in `ARCHITECTURE.md` §3 gets a corollary it did not have — **the cheap model is only cheap if the session stays short**; a Sonnet session that runs long costs more than an Opus session that does not.

  **Also Day 5, mine and not inherited: the test suite was pinned to `HOLDOUT_SEED`.** I wrote `const SEED = 90_210` into G2's `events.test.ts` and repeated it in G4 and G5; it propagated to roughly forty call sites by G6. ADR-027 reserves that seed for the reported numbers and says to look at it **once, when reporting** — but a suite pinned to it looks at it on every run, and every fix made to turn one of those tests green is a change made by inspecting holdout output. That is precisely the tuning ADR-027 forbids, arriving through the test suite rather than through the engine, and it would have been invisible because every test was passing. Generator tests now run at `DEV_SEED` with property sweeps over arbitrary non-reserved seeds; `HOLDOUT_SEED` survives in exactly one smoke test that asserts the seed runs and records itself, never what the dataset contains.

  **Two more spec numbers that could not be satisfied,** both found only by building the thing they described. §1's *"200-500 records"* never followed from §3's own weight table — two thirds of events are 3-way scenarios, and the honest total is 920 (ADR-069). §2.3's *"days ≥ 13 in ~30% of rows"* is arithmetically unreachable: **any** contiguous 30-day window contains 18-19 days above the 12th, so the floor is 60% unambiguous and the dataset sits at 57.8% (ADR-070). In both cases the correction was to the doc rather than to the generator — bending the generator to hit a stale number would be tuning the dataset to a figure rather than to a purpose, which is the failure this project's whole validation strategy exists to rule out. The §2.3 purpose (an inferring parser must be visibly, frequently wrong) is served comprehensively at 42% ambiguous, and there is now a test holding that above 35%.

  **The honest summary.** Day 3 established that writing a spec down catches one class of flaw, Day 4 that running it catches another, Day 5's audit that auditing your own output catches a third. Day 5 adds a fourth, and it is about the seam between components rather than inside one: **the invariants and the proofs were both correct and both passed, and the bug lived in the gap between them** — in the emitted string, after the last typed check and before the first parse. Three layers of verification, and the defect walked between two of them. The fix that generalises is not another invariant; it is that the formatter and the parser are now required to agree, enforced at the formatter, where the value is created.

- **2026-08-28 (Day 6)** — **Ingestion and the first two tiers landed in two units, and an isolated audit of them found eight issues, two of them P1. Both P1s were silent: nothing threw, 338 tests passed, and each would have quietly moved the number this project is graded on.** Day 6's work landed on Aug 28 alongside Day 5's; the day count is 13 *working* days, so the calendar is a day ahead of the plan rather than the plan being behind.

  **What landed.** U1: three source parsers, exclusion rules, rejected-row capture, and the aggregator that becomes S4's input. U2: the four §3 block indexes, the Tier 1 exact predicate and its driver, and Tier 1.5 re-running that same predicate on alias-substituted values. Then AUDIT-1 — an isolated Opus session, audit-only, permitted to file issues and forbidden to fix anything.

  **THE FIRST P1: nine refunds that could never reach their ledger row (#30).** A `refunded` gateway row normalizes to `direction = 'debit'` (ADR-035). The ledger parser assigns `'credit'` to every row — correctly, in the sense that `merchant_ledger.csv` **has no direction column at all** (§2.3), so there is nothing else it could assign. Direction is a hard gate at every tier, so the gate was comparing a gateway fact against a value this codebase invented, and for a refund it always lost.

  All nine `REFUND_REVERSAL` events therefore failed at S6, S7, S8 **and** S9. Eighteen expected pairs unreachable, nine `MATCH_3WAY` events degraded to 2-way, and nine orphaned ledger rows that would have surfaced as presence exceptions the answer key says should not exist. S8 had a verdict for it — `direction_conflict`, whose reason string literally reads *"this is a refund or reversal pairing"* — so the engine recognised the shape correctly and then dropped the pair, because **`direction_conflict` has no consumer anywhere in the codebase.** A stage identified the case, named it accurately, and threw the answer away.

  The failure mode matters more than the count. This would not have shown up as a lower match rate alone; it would have manufactured nine exceptions with confident, wrong explanations, which S13 would then have narrated in plain English to a judge. **Inflating the exception list with non-problems is the failure `schema.md` §2.2 already names as "equally dishonest" to hiding exceptions** — and here the engine would have been fluent about it.

  **Recovered by** ADR-071: the gate now abstains unless *both* sources state a direction. Gateway does (via `status`), bank does (via which amount column is populated), ledger does not. ADR-035's actual argument — a ₹5,000 capture must not match a ₹5,000 chargeback — is a gateway↔bank argument, and it is untouched.

  **THE SECOND P1: the bank's merchant name was very nearly a primary key (#31).** `counterparty_norm` on **248 of 301** bank rows still carried the RRN and the `setl_…` token:

  ```
  "UPI-SETL-FSN E-COMMERCE-510996260123-setl_xot9xgPg5duO6q-BATCH81"
    -> "FSN E COMMERCE 510996260123 SETL_XOT9XGPG5DUO6Q"
  ```

  253 distinct values across 301 rows. The `byCounterparty` block index — whose stated job is *"catches amount-divergent, name-agreeing pairs"* — had almost no bucket with more than one row in it. Tier 2's counterparty component was comparing forty characters of noise. And bank-side **alias learning was structurally impossible**: `learned_aliases` keys on `normalized_value`, and a value embedding a row-unique reference can never be aliased to a canonical merchant. The holdout ships 11 merchant-name alias entries and 24 `MERCHANT_NAME_VARIANT` events with nothing to act on, which also means the **leverage ratio** — named in `CLAUDE.md` §6 as the alias feature's honest headline — had no path to a numerator.

  **This is the Day 5 lesson again, in a different seam, and worth being precise about why.** The normalizer stripped a trailing `BATCH\d+`, then trailing digit runs. That is *exactly correct* for `schema.md` §2.2's worked example, `"NEFT-SETL-AMZN RETAIL-234567890123-BATCH12"`, whose token order is MERCHANT-RRN-BATCH. The generator emits `MERCHANT-RRN-setl_ID-BATCH` — one extra token, sitting precisely where it halts a tail-anchored loop. **The code was written against the doc's example and was right about it; the doc's example was not the data.** The 53 rows that came out clean were the ones where the generator happened to omit a token, which is what turned a hypothesis into a diagnosis.

  **Recovered by** filtering reference-shaped tokens at any position, then re-applying the legal-suffix rule (a suffix that was not final before the references were removed is final now — this is what gets the bank's `ZOMATO LIMITED 818624673100 setl_…` to the gateway's `ZOMATO`). Distinct bank norms 253 → 33; bank↔gateway overlap 34/301 → **276/301**. `schema.md` §3.3 gains rule 6, because its rule list never said to remove embedded references even though its own stated outcome, `AMAZON RETAIL`, requires it.

  **WHY NEITHER WAS CAUGHT BY THE 338 PASSING TESTS.** The Tier 1 holdout suite has a good precision test — *"every Tier 1 match is a true positive in the answer key"* — which correctly found zero false positives, and still does. Its only recall-shaped assertion was:

  ```ts
  test('the exact tier carries a meaningful share of the load, …', () => {
    assert.ok(result.matches.length > 150, …);   // actual: 194
  });
  ```

  Forty-four matches of headroom under a title that claims a load-share property. **This is the fifth instance of the pattern Day 5 named** — *a test whose name makes a claim its assertion does not check is worse than no test* — and it is the most expensive one yet, because the answer key was already loaded in that exact test block and the expected-pair set was already built one test above. Computing recall from data that was sitting in scope would have printed `MISSED 18` on the first run. Filed as #33 rather than fixed here, since AUDIT-1 was audit-only and the fix belongs with the P2 sweep.

  **The generalisable half.** Day 3: writing a spec down catches one class. Day 4: running it catches another. Day 5: auditing your own output catches a third, and the gap *between* two correct verification layers catches a fourth. Day 6 adds a fifth, and it is about **who** is looking: an audit run in a fresh session, forbidden to fix anything, found two silent defects that the session which wrote the code had already reviewed and self-flagged six judgment calls about. Five of those six self-flagged calls turned out to be correct — the author's judgment was good. **What the author could not do was doubt the thing they had not thought to question**, and both P1s lived exactly there: in `direction`, which nobody had asked whether the ledger was entitled to have, and in a normalizer that had been verified against the doc's example rather than against the file.

  The cheap operational lesson, since AUDIT-1 cost a fraction of what G6 did: **an audit that may not fix anything stays short.** Removing the ability to act removed every temptation to sprawl.

  **Also Day 6, smaller:** six issues below P1 filed and left open by design (#32–#37) — an `anchor_strength` that ignores `invoice_no` and so tells a controller "there was nothing to find" while an invoice number sits in the row; the recall test above; a `viaTier` reconciliation rule U9 needs before Day 9; a Tier 1.5 guard that a type-only import satisfies; three spec-required ingestion paths with zero fixture coverage (ADR-036's `FEE` exclusion among them — the generator emits none); and a doc example that contradicts correct code.

- **2026-08-28 (Day 7)** — **Tier 2, group assembly, classification integration and the repository layer, in three units. Nothing broke loudly. What Day 7 produced instead is a pattern worth naming: three separate modules, each written correctly against a spec, each wrong the first time something actually called it.**

  **What landed.** U3: the S9 candidate-generation driver and S11's pair-to-group assembly. U4: the S12 integration that turns stage output into `ClassificationInput`. U5: all eight repositories, plus migration 012.

  **THE PATTERN, stated once because it is now the dominant failure mode.** Days 3 and 4 built the engine's decision-making core against the docs. Day 6 found two P1s in it. Day 7 found three more defects of exactly the same shape, and none of them were found by reading:

  1. **`candidatesConsidered` was reporting the length of a filtered list.** `matching-engine.md` §11 says in as many words that it must be *"a true count rather than the length of the logged list"*, and `schema.md` §9.1 sets a 0.40 floor on what gets logged. `classify.ts` computed `scored?.candidates.length`, which makes the two identical — correct until a caller applies the floor, which U4 was the first to do. An exception would have told a reviewer the engine tried three counterparts when it tried ninety, understating the search inside the very exception they are being asked to trust.

  2. **§10 rule 3 was documented and inert.** S11 computes a refusal for every pair it declines — the losing record and the group that displaced it — and nothing consumed it. `ClassificationInput` had no slot for refusals, so the `AMBIGUOUS_MATCH` that rule 3 specifies could not be raised at all. Wiring it needed a *separate* input from S9's ambiguity findings, because collapsing the two would put S9's "two candidates scored too close to call" wording on an S11 finding where nothing was scored.

  3. **The alias schema made its own documented policy impossible to execute.** Three constraints from migration 005 — `ux_alias_active`, `alias_superseded_has_target`, and the `superseded_by` foreign key — are each correct, and jointly form a cycle: the new row cannot be `active` until the old one is not, the old one cannot be `superseded` without naming its successor, and it cannot name a successor that does not exist yet. **Every statement order violates one of the three.** §6.3's supersede-with-penalty policy was specified on Day 2 and written into the schema on Day 3; nothing executed it until `upsertAlias` on Day 7. Migration 012 defers only the FK, so the unique index and the CHECK keep firing immediately and neither property that protects the data is weakened.

  **What these three have in common** is not that the specs were wrong — all three specs were right, and precise. It is that **a spec cannot be executed by reading it.** Each defect sat in the gap between a module and its first real caller, and every one of them was invisible to a typechecker, to a unit test of the module in isolation, and to a careful reading of the doc. The Day 5 entry called this "the seam between components". Day 7's contribution is that the seam is not an occasional hazard; on this project it is where most remaining defects live, because the modules were built early and correctly and the callers are arriving now.

  **The operational consequence, which is a testing decision.** U5's integration test was written for exactly this reason — TypeScript typechecks the SHAPE of a query result and says nothing about whether the SQL parses, whether a column exists, or whether a CHECK will refuse the write. It failed seven times on its first run. **Six of those seven were bugs in the test, not the code.** That is now roughly the eighth time in five days that a red test was the test's fault, and the ratio is stable enough to plan around rather than apologise for: the first run of a new integration test is a debugging session for the test, and budgeting for that is cheaper than being surprised by it.

  **A near miss worth recording, since leaving it out would flatter the process.** U3's test suite reported a determinism failure across two pipeline runs. Determinism is ADR-032's core guarantee, so this looked like the most serious possible finding. It was `shape(groups)` where `shape` expected the whole run result — my own test bug, caught only because I checked the engine independently before believing the test. Had I reported it first, the next hour would have gone into a hunt for a bug that did not exist.

  **Also Day 7, filed rather than fixed:** [#38](https://github.com/flare19/payment-reconciliation-agent-platform/issues/38), a P1. `anchorAgreement` compares weak anchor keys like-for-like, and `bank_ref_no` exists only on bank rows — so a bank row whose `bank_ref_no` is byte-identical to a gateway `rrn` scores **zero** anchor and falls below the review floor on amount, date and counterparty alone. 128 of 301 bank rows carry such a value; ~24 true gateway↔bank pairs are currently unreachable. It lives in `scoring.ts`, which was out of U3's scope and is the single guard-tested scorer, so it was filed with a deadline (before AUDIT-2 on Day 8), measured evidence, and acceptance criteria written so that a fix which merely loosens matching cannot pass.

- **2026-08-28 (Day 8)** — **The engine ran end to end and was persisted for the first time, and all 28 endpoints went up. Then a commit message closed a P1 issue by saying the opposite of what it meant.**

  **What landed.** U6: the run orchestrator, S0–S12 against a real Postgres — 920 transactions, 284 matches, 555 exceptions, 930 audit entries, chain valid and anchored, 983 ms. U7: the 28 endpoints of the binding contract, every one exercised over real HTTP.

  **THE ONE THAT MATTERS, because it is a new failure class.** Commit `f2a1245` carried the line *"Known shortfall, filed not fixed: #38"*. GitHub's closing-keyword parser matches `fix(e[sd])?\s*:?\s*#\d+` and does not read the surrounding sentence, so **`filed not fixed: #38` parsed as `fixed: #38`** and auto-closed a live P1 the moment the branch reached `main`. The sentence said, in English, the exact opposite of what the machine did with it.

  It was caught only because the next session's plan called for reading the open-issue list before writing an audit prompt. Nothing in the test suite, the typechecker or the review could have caught it — **the artifact that was wrong was prose, and the reader that acted on it was a regex.**

  The same phrasing was sitting in the U6 commit for #39, unpushed. It would have closed that one too on the next push. Corrected before merging; both issues are open.

  **Recovered by** reopening #38 with a comment explaining the mechanism, so a future reader does not find a closed P1 with no fix and conclude it was handled. **Changed as a result — a rule:** never write `fix` / `fixed` / `closes` / `resolves` anywhere near an issue number in a commit message unless the commit does it. To reference without closing: `see #38`, `per #38`, `tracked in #38`. And a pre-merge grep, because this is exactly the class of thing that is invisible until it has already happened:

  ```
  git log --format=%B main..HEAD | grep -inE "(close[sd]?|fixe[sd]|fix|resolve[sd]?)[ :]*#[0-9]+"
  ```

  **Why this is worth a full entry rather than a line.** Every previous failure in this document was a defect in code or in a test, found by running something. This one was a defect in *documentation of intent*, found by nobody — it was going to be discovered as "why is the P1 we planned Day 8 around already closed?". The project's whole thesis is that honest reporting is a feature; a commit message that reports the opposite of what happened, to a reader that acts on it automatically, is that thesis failing in the least dramatic possible way.

  **Two design calls in U6 worth recording,** both flagged in the plan as judgment rather than transcription:

  *Transaction boundaries.* The obvious design — one transaction per run — is wrong for a non-obvious reason: `GET /api/runs/:runId` is the poll target while a run is in flight, and status lives on the `runs` row, so an uncommitted status is invisible. One transaction would leave a run at `pending` for its whole duration and then jump to `completed`, making the progress bar decorative. The run is therefore a sequence of phase transactions. The cost is stated rather than hidden: a crash mid-run keeps the phases that already committed, which is what ADR-046's reaper exists for and is the honest outcome — the alternative is a run that silently looks like it never happened.

  *Audit-write points.* The log is a trail of DECISIONS. Ingestion is a transcription — `transactions` already holds every row with `raw_payload` intact — so it is one entry per source, not per row. `MATCH_CANDIDATE_REJECTED` is absent entirely: §9.1 floors it at 0.40 because logging every pairwise rejection is ~90k rows at 300 records. A trail nobody can read is not a trail.

  **A smaller thing fixed mid-build:** S8 re-derives every pair S6 already claimed and reports `outcome: 'match'` "for completeness". Logging all of them put a second entry beside every `MATCH_CONFIRMED_EXACT` and claimed the identity stage contributed 212 findings when it contributed **9** — the amount/timing verdicts Tier 1 declined, which is the only thing S8 is for.

  **Filed rather than fixed:** [#39](https://github.com/flare19/payment-reconciliation-agent-platform/issues/39), P2 — audit append costs one round trip per entry and is **~37% of a run** at 0.395 ms/entry, projecting to ~310k entries and **~122 s of pure audit writing** at ADR-045's 100k benchmark. A throughput curve dominated by a bookkeeping write says nothing about the matching engine, which is what the benchmark exists to characterise. Due before U16.

- **2026-08-29 (Day 9)** — **AUDIT-2 found the P1 it existed to find, one day before the number goes out. Tier 2 had been excluding whole RECORDS where the spec excludes PAIRS, and the engine had been reporting a match rate 10.76 points below what its own rules produce — alongside 193 exceptions that told a reviewer the engine had searched and found nothing, on records it was structurally forbidden from searching.**

  **The defect, in one line.** `matching-engine.md` §6.3 says *"Tier 2 now only ever sees **pairs** where identity is not established."* `runTier2` filtered its pool by `!claimedIds.has(t.id)` — records. The two read as the same rule and are not.

  **Why the difference is enormous rather than academic.** AUDIT-1 had already established that Tier 1 only ever produces gateway↔ledger matches: bank rows carry no *structured* strong anchor (§3.1), so `sharedStrongAnchor` is always null for gateway↔bank. Both facts were known and written down. Nobody put them together. Excluding matched records means **every gateway Tier 1 matched was deleted from Tier 2 before its bank leg could be scored**, which makes §10 rule 2 — "gateway↔bank plus gateway↔ledger on the same gateway record produces one 3-way group" — impossible to satisfy for the 203 records it most applies to. The rule was implemented, tested, and unreachable.

  **What it cost, measured against the committed answer key:**

  ```
                          before      after
  pair recall             344/872     658/872     +314 true pairs
  false positives           0           0         precision unchanged
  three-way groups          30         187
  groups                   284         284         same events, assembled more completely
  match members            598         755
  exceptions               555         256
    MISSING_IN_BANK        203          54
    MISSING_IN_GATEWAY     242          90
  match rate (ADR-040)   57.09%      67.85%       ceiling is 93.0%
  ```

  **The half that reached a reader, and the reason this is the worst defect in the project so far.** 193 of the 203 `MISSING_IN_BANK` exceptions sat on gateway records Tier 1 had matched. Every one reported `candidatesConsidered: 0` and served over HTTP as `resolvability: "needs_external_data"` — *"no candidate, but the record carries some reference → the counterpart may exist outside these three files."* The counterpart was in the file. The engine had not looked, and said it had. `tier2-fuzzy.ts` opens with a boxed warning that says exactly this — *"a candidate never generated is a match that cannot be made, and nothing downstream can tell the difference between that and a genuine exception"* — written by the session that then wrote the bug eleven lines below it.

  **What the tests were doing.** 477 of them passed, including one titled *"pair-level recall is at its known level, and every shortfall is an ENUMERATED cause"*. It pinned `hit = 344` exactly — a genuine improvement on #33's floor, and it did catch the change — but the title's second clause was asserted nowhere. **396 of the 528 misses shared one cause and nothing was classifying them.** Enumerating them is what found the bug; the enumeration is now in the test, with exact per-cause counts, and a miss matching no cause fails. This is the ninth instance of *a test whose name claims more than its assertion checks*, and the first where the unasserted clause was hiding a P1 rather than a rounding error.

  **The generalisable half.** Day 6 established that an audit in a fresh session finds what the author could not doubt. Day 9 sharpens it: **both facts this bug needed were already written down, in this repo, by the same author, days apart** — §6.3's "pairs", and AUDIT-1's "Tier 1 only ever produces gateway↔ledger". The defect lived in the *conjunction*, which no single document owns and no single test covers. Writing a fact down does not make it composed with the other facts. That is a different failure from "the spec was wrong" (Day 3), "the spec was not executed" (Day 7), or "the author could not doubt it" (Day 6), and it is the one an audit is actually for.

  **Changed as a result.** The signature is now the guard: `runTier2` takes `readonly { aId, bId }[]` instead of a `ReadonlySet<string>`, so a caller holding a set of record ids **cannot typecheck**. Three new assertions carry the property rather than the number — every miss attributed to a named cause; a record must appear in both an exact pair and a Tier 2 pair (§10 rule 2, exercised by data); and an exception may report finding nothing only if the engine actually searched. That last one was run against the pre-fix engine before being trusted: it produces **200 findings**, which is how a test earns the right to be green.

  **One number that looks like a regression and is not.** `MATCH_CONFIRMED_EXACT` fell 203 → 46. Tier 1 still produces all 203 pairs; 157 of their groups now also hold a fuzzy bank leg, and §10 rule 5 reports a group at its **weakest** tier. 203 − 157 = 46. Reporting those as `exact` would overstate the evidence for the leg a sceptical reader is most likely to check — the rule costing match-quality-on-paper exactly as designed.

  **Also from AUDIT-2, filed rather than fixed:** [#41](https://github.com/flare19/payment-reconciliation-agent-platform/issues/41) P2 — `candidateAmountBuckets` inverts the fee band for bank→gateway, using `feeBandMinPct` where the upper bound needs `feeBandMaxPct`; 9 true pairs fall outside the span and all 9 are currently rescued by another candidate source, so it costs nothing today and scales with amount. [#42](https://github.com/flare19/payment-reconciliation-agent-platform/issues/42) P2 — S11 rule 3 names the refused pair as its own displacer. [#43](https://github.com/flare19/payment-reconciliation-agent-platform/issues/43) P2 — `countsTowardEngineMatchRate` admits `pending_review`, which ADR-040 excludes, so the browse list implies a higher rate than the headline. [#44](https://github.com/flare19/payment-reconciliation-agent-platform/issues/44) P2 — three tests that cannot fail. [#45](https://github.com/flare19/payment-reconciliation-agent-platform/issues/45) P3 — S11's cluster-merge branch is unreachable and discards pairs if reached.

  **Verified correct and worth recording as such,** because silence is not a result: `candidateDateRange` inverts the §5.2 windows correctly in both directions (854 true pairs checked, 12 misses, all of them S10 batch legs); the ADR-033 cap does not bind; `matchedPairs` derives from S11's groups so a refused pair cannot reappear as matched; `candidatesConsidered` is a true count, differing from the logged list in 308 of 555 exceptions; every paginated repository query ends in a unique tiebreak; migration 012 weakened neither the partial unique index nor the CHECK; and no unwired stage fabricates a value — `headline` is `null`, `runs.metrics` is `{}`, `measured` is never backfilled from `engine`.

  **Later on Day 9 — U8 (S14 metrics), and two things it caught.**

  **A reader written against a producer that did not exist.** `serialize.ts`'s `headline` block read `m['review']?.['pendingReviewCount']`; the metrics block is named `reviewBurden` (schema.md §11.1). U7 wrote that read on Day 8 against a `runs.metrics` that was `{}`, so `?.` resolved to `null` on every run and nothing failed. `schema.md` §11.5 rule 3 requires review burden to travel *with* the match rate — and this is the one way to break that rule silently: not by omitting the field, but by shipping it permanently null. **58 pending-review groups would have rendered as "—" next to the headline for the whole demo.** Day 7 named the pattern as "a module correct against its spec, wrong the first time something called it"; this is its mirror — a CONSUMER correct against its spec, wrong because the producer arrived later and nothing re-checked the seam.

  **An overstatement caught before it shipped, because Day 8 had already found it once.** The first `tierAttribution` draft reported `identityEstablished: 212`. S8 re-derives every pair S6 already claimed and reports `outcome: 'match'` "for completeness"; the real contribution is the **9** amount/timing verdicts Tier 1 declined. Day 8 removed exactly this inflation from the audit log and wrote down why. Reintroducing it under a different name in a different file, one day later, is worth recording plainly: **a lesson learned in one module does not propagate to the next by itself.** The fix is the same filter, and the test now pins both numbers — 9 as the answer, 212 as the number it must never report — so the next place this appears fails rather than publishes.

  **The denominator, which is what U8 was flagged as risky for.** ADR-040 says `reconcilable = ingested − excluded − rejected_rows − non_primary_duplicates`. That sentence is only coherent if `ingested` means **rows read from the files** — but `ingestion/index.ts` builds `counts.gateway` from `gateway.transactions.length`, and a row that failed to parse never becomes a transaction. So an implementer who sums the three source counts and *also* subtracts `rejected` removes rows that were never added, shrinking the denominator and **inflating the match rate**. On the holdout `rejected = 0`, so all three readings agree at 874 and the error would have been invisible. `population.ingested` is now file rows attempted, stated in the object itself, and `assertDenominatorIdentity` re-derives the arithmetic and **throws** rather than publishing a rate whose denominator does not reconcile. A run that cannot account for its own denominator should fail, not round.

  **Still Day 9 — U9 (`tools/score`) and U10 (the first scored run). The project has a MEASURED number for the first time, and getting it required admitting two scorer bugs and one contract gap.**

  **THE NUMBER, unedited, as ADR-020 requires:**

  ```
  pairs      precision 1.0000 · recall 0.6173 · F1 0.7634
             TP 442 · FP 0 · FN 274
             review queue: 150 pending pairs at 0.94 precision
             165 pairs excluded from both sides (their EVENT is an exception, ADR-072)
  classify   macro P 0.7222 · macro R 0.7309 · secondary-flag Jaccard 0.80
  honesty    unresolvable recall 1.0 over 21 · false-despair 58/74 = 0.78
  difficulty EASY 0.71 · MEDIUM 0.67 · HARD 0.20
  engine     match rate 67.85% against a computed ceiling of 93%
  ```

  **Zero false positives is the number worth reading first.** The engine claims 442 pairs and every one of them is in the key. Recall 0.617 says it finds under two-thirds of what is there — the honest weakness — and HARD at 0.20 says exactly where. That is a better result to report than a higher F1 with a non-zero FP count, and it is the shape this project chose deliberately: refusing to guess is a feature.

  **THE SCORER WAS WRONG TWICE ON ITS FIRST RUN, AND BOTH TIMES IT SAID THE ENGINE WAS WORSE THAN IT IS.** The first execution printed two build blockers: "the engine INVENTED a match on 5 designed-unresolvable events" and "3 TIMING_DRIFT events auto-confirmed". Both were scorer defects.

  - The unresolvable check asked "was any pair inside this event confirmed?" But §4's three sub-classes are unresolvable **in one leg**, not throughout: an `UNSPLITTABLE_NET_BATCH` event is a bank credit that nets N payments with no breakup file, and the gateway and ledger rows behind each payment are ordinary rows that match on `payment_id`. **The key says so itself** — all three pairs of all five flagged events carry `shouldMatch: true`. The engine was right and the scorer called it invention.
  - The TIMING_DRIFT cell read `expectedSecondaryFlags` where §5.2 means the primary `expectedCategory`. TIMING_DRIFT rides along as a secondary flag on `AMOUNT_MISMATCH` events whose gateway↔ledger leg legitimately matches, so the blocker fired three times on a clean run. The holdout has **no** event whose primary category is TIMING_DRIFT, so the correct cell is structurally zero here.

  **Why this is the entry that matters.** `tools/score` was flagged in the plan as *"the purest case: no test can catch a scorer that is wrong in the direction you hoped."* Both bugs were wrong in the direction nobody hopes for, which is the only reason they were caught in one run. Had either gone the other way — a check that quietly passed a real invention, or a recall denominator that dropped a few misses — the number would have looked *better*, nothing would have complained, and it would have shipped. **The asymmetry is the whole lesson: a scorer's optimistic bugs are silent and its pessimistic bugs are loud, so the loud ones are a gift and the silent ones are what an audit has to go looking for.** Correcting a check until a blocker stops firing is also indistinguishable from tuning, so every gate now has a test asserting it still FIRES on genuinely wrong output, not merely that it passes on the real run.

  **A contract gap that made the documented measurement impossible (ADR-073).** §5 says the scorer joins engine output to the key on `(sourceSystem, sourceRowNumber)`, and §2.1 explains why it must: the key is written before the engine exists and cannot reference engine-assigned UUIDs. But `RecordPreview` — the record shape inside every match member and exception — carried `transactionId` and `sourceSystem` and **not** `sourceRowNumber`. The only endpoints exposing a row number were 24 (which lists exactly the rows *outside* the denominator) and 12 (one transaction per request). **Two locked documents specified a measurement the contract between them could not carry**, and nothing surfaced it — not the typechecker, not 498 passing tests, not a careful reading of either document alone — until U9 tried to execute the join and got a 404. This is the Day 9 seam lesson a third time: the gap was not inside any module, it was between two documents that were each internally correct.

  **A smaller one worth naming because it wasted a cycle:** the first scored run reported `precision 0, recall 0, TP 0` against an engine that had matched 658 pairs. The cause was a stale `tsx` process still serving the old `recordPreview` on port 3001 — the code was right and the server was old. Loud, harmless, and a reminder that "I restarted it" is a belief until the response body says so.

  **End of Day 9 — what the measurement turned into, once the never-found set was actually opened.**

  "~80 pairs never found" was a bucket, not a diagnosis, and buckets hide things. Opening it produced a number that changes what Day 10 and 11 are for:

  ```
  never-found true pairs .................................... 133
    viaTier = batch — S10 built, tested, NEVER CALLED .......  48   #46 P1
    bank<->ledger capped at 0.55 against a 0.65 bar .........  42   #47 P1
    gateway-bearing, awaiting diagnosis (30 overlap #38) ....  43
  candidates never generated ................................   0
  ```

  **Zero.** Not one of the 133 was missed by candidate generation. Every one was generated, scored, and fell below a threshold. The blocking strategy is doing its job; the scoring model is not.

  **#47 is the one that would have been catastrophic to ship, and it is arithmetic rather than tuning.** `schema.md` §4.3 gives bank and ledger no comparable amount basis, so `scorePair` contributes 0 for the amount component — and does **not renormalise the remaining weights**. Best case for a bank↔ledger pair is `anchor 0.20 + date 0.20 + counterparty 0.15 = 0.55`, judged against `fuzzyReviewThreshold = 0.65`. **A bank↔ledger pair with a matching anchor, an exact date and an identical counterparty is refused.** There is no input that passes. Measured: of 244 true bank↔ledger pairs the engine reaches 178, and **every one only as a three-way group's implied leg — zero on their own merit.**

  Two locked decisions had never been reconciled: ADR-030 calibrated the weights assuming all four components apply, and §4.3 created a source pair where one never does. Neither is wrong alone. **This is the Day 9 seam again — the fourth time today** — and it is the sharpest instance yet, because the two documents are not merely inconsistent, they are jointly impossible, and the impossibility is a one-line sum that nobody had performed.

  **Why this was invisible for six days.** bank↔ledger pairs mostly arrive as the *implied* third edge of a three-way group, where the gateway leg carries them, so 178 of 244 look matched and the category never reads as broken. Only a scorer that asks "reached on its own merit?" separates the two, and that question did not exist until Day 9.

  **The discipline this sits inside, written into ARCHITECTURE §8.1 and habit 0.** The measurement also showed that `fuzzyAutoConfirmThreshold` at 0.85 is the entire difference between the 442 auto-confirmed pairs and the 583 the engine actually found — lowering it would lift the headline overnight. **That change is forbidden and #47's is not**, and the distinction is the whole point: a scale that omits an inapplicable component and then compares against a full-scale bar is wrong on its own terms, arguable without any holdout number, and would be wrong if the holdout did not exist. A threshold change would be arguable only by pointing at the number. **If the argument for a change is "the holdout number goes up", the argument is the evidence against it.**

  **Also settled today: the deploy posture (ADR-074).** Deploy moves to Day 10 not to tick it off but to meet the environment's unknowns while there is still time to absorb them — nothing here has ever run outside a laptop. Four P1s are open on the day it deploys and all of them land afterwards, so the deployment is judged on how cheaply it REDEPLOYS rather than on being finished. No CI/CD: one person, one branch, two `npm test` commands and a review gate that already exists. The cost is stated rather than hidden — without CI, "the tests passed" is a claim about what somebody ran, not a property of the commit.

- **2026-08-30 (Day 10)** — **I filed a P1 that was not one, and the check that caught it was reading the ADR log before writing code.**

  Day 10 opened by implementing #47 — renormalise the Tier 2 score over applicable weights, because an anchorless `bank↔ledger` pair caps at 0.35 against a 0.65 review floor and therefore cannot be matched. The arithmetic is real. The issue was still wrong, on two counts, and both were knowable before a line was written.

  **It was already decided, deliberately, on Day 4.** `schema.md` §5.4 documents the behaviour and cites **ADR-064**, which found the same thing during the Day 4 self-audit, computed the *exact* figure I re-derived (`strong_weak: (0.30+0.20+0.15)/0.65 = 0.846`), and declined to change it — because *"rewiring a scoring weight unattended, before the project has produced its first measured accuracy run"* is precisely what ARCHITECTURE §7 asks to be flagged rather than decided alone. It left a revisit condition: bank↔ledger exceptions where **an anchor-matched** counterpart exists but never reached review.

  **The revisit condition is measurably not met, and the fix recovers zero pairs.**

  ```
  TRUE bank<->ledger pairs .................. 244   reached 178   never reached 66
    of the 66, anchor component > 0 .........   0
    of the 66, sharing ANY reference value ..   0
  every bank<->ledger pair scorePair accepts: 83,979 — anchor 0.00 on ALL of them
  pairs renormalisation would lift to review:   0
  ```

  No bank↔ledger anchor exists anywhere in this dataset, so the 0.55 and 0.65 caps the issue is named after are theoretical. Every real pair maxes at `date 0.20 + counterparty 0.15 = 0.35`, and renormalised at 0.538 — both below 0.65. The 66 rows carry **disjoint identifier namespaces**: bank has `bank_ref_no` + `utr`, ledger has `entry_id` + `invoice_no`. There is no anchor to find, which also rules out #38 as their cause.

  **So the engine was right and the issue was wrong.** Two rows sharing no identifier, with no comparable amount and only a date and a merchant name, are not a match anyone should assert. Refusing them is this project's entire thesis, and I had written it up as a catastrophe.

  **What made it wrong is worth naming precisely.** Every prior defect this month lived in a seam between artifacts that were individually correct, and I had started treating "two documents that jointly imply something impossible" as the signature of a real bug. Here the two documents **agreed**, an ADR explained why, and I never opened it — I derived the arithmetic myself, found it damning, and filed. **A striking sum is a reason to search the decision log, not a substitute for having searched it.** The cost of not searching would have been a scoring change made after seeing a measurement, recovering nothing, raising bank↔ledger ceilings across the board, and risking the strongest number the project has — precision 1.0000, FP 0 — in exchange for zero.

  **Recorded so it cannot recur:** ADR-075 states the condition was evaluated and declined, with the measurement, because `0.55 < 0.65` is exactly the kind of sum that looks like an obvious bug on a fresh reading. That is how it got filed the first time.

  **One genuine finding did fall out of it** — [#48](https://github.com/flare19/payment-reconciliation-agent-platform/issues/48). §5.4 promises that a pair with no shared reference *"can reach the review band and ask a human, and that is all it can ever do."* For bank↔ledger the second half is false under either arithmetic, so a human is never asked and the record serialises as `needs_external_data` — *"the counterpart may exist outside these three files"* — about a counterpart sitting in the ledger file. A spec that lies about one of three source pairs, and a confidently wrong sentence in front of a reviewer.

  **Corrected attribution of the 133 never-found pairs:** 48 are S10 unwired (#46, real, Day 10); **42 are the engine correctly refusing anchorless bank↔ledger pairs**; 43 are gateway-bearing and still unexplained, which is where the recall gap actually lives.

  **Also Day 10 — the 43 gateway-bearing misses, diagnosed. The never-found population is now fully attributed, and it is mostly the engine being right.**

  Every one of the 43 has the identical shape: **perfect amount (delta 0, exact to the paisa), in-window date, perfect counterparty trigram, and `anchor = 0`.** They score 0.50–0.60 against a 0.65 floor. One test splits them — do the two rows share a reference *value* under *different* keys?

  ```
  sharing a value under different keys (#38) ....... 11
  sharing no reference value at all ................ 32
  ```

  The 11 are all `bank_ref_no == rrn`: a byte-identical 12-digit reference sitting on both rows, contributing nothing because `anchorAgreement`'s weak-key loop compares the *same* key on both sides and no bank row has an `rrn` field. That is #38, already a P1, and this raises its standing — those 11 are not merely under-scored, they are never surfaced to a human at all.

  **Final attribution of the 133 never-found pairs: 48 S10 (#46), 11 #38, and 74 the engine correctly refusing pairs with no shared identifier.** Only **59 are actionable**. That is a much better result than "133 missing" implied, and it took two days of measurement to see.

  **A second finding, folded into [#48](https://github.com/flare19/payment-reconciliation-agent-platform/issues/48) rather than filed fresh.** The date component is `0.20 × (1 − days_off / window_span)`, which is exactly zero when `days_off == window_span` — **on the SLA boundary, inside the window**. A T+3 card settlement, which ADR-009 defines as normal, scores the same date evidence as one thirty days late: none. Consequence: an anchorless pair with perfect amount and counterparty sits at 0.50 and needs three-quarters of the date weight to clear the floor, so **for every window the engine defines it reaches review only on a same-day match**. `schema.md` §5.4 and ADR-030 publish the opposite property — *"it can reach the review band and ask a human"* — and 20 of the 43 score zero on date while inside the window they were measured against.

  **Folded rather than filed because it breaks the same sentence #48 already names.** After #47 — where I filed a P1 that an ADR had already decided — the instinct to open a new issue for every striking number is the thing to distrust. Two mechanisms, one false sentence, one fix conversation.

  **And the same honesty applies to its yield:** correcting the date curve alone would recover approximately nothing. Those pairs are missing 0.30 of anchor weight; a plausible re-shaping moves them 0.50 → 0.55, still short. Recording it as a defect in the *published property* rather than as a recall opportunity is the accurate framing, and #48's recommended resolution is still to make the documentation true rather than to change the arithmetic.

  **Also Day 10 — S10 wired (#46). It runs, it is honest, and it recovers nothing, and the reason is the #40 error in a new stage.**

  `batch-stage.ts` is the caller `batch-decomposition.ts` had been waiting for since Day 4. Splits (§8.1) run first because their evidence is identity-bearing; batches (§8) follow over what splits left. Four decisions the docs never made are argued in ADR-076.

  **Two over-claims the wiring surfaced, both caught before they shipped.**

  The first wired run produced a `decomposed` verdict containing **one** gateway payment — a 1:1 pair Tier 2 had already scored and declined, re-decided by S10 on strictly weaker evidence, since the batch pool requires no anchor at all. `searchSubsetsInBand`'s own docstring already states the rule for the split path — *"a size-1 solution is an ordinary 1:1 match that belongs to the tiers, not to this stage"* — and the batch path had never passed the minimum. **A rule written down in one branch of a module and not applied in the neighbouring branch**, invisible until something called it.

  The second would have been worse. Without a pool-shape floor, wiring S10 relabels **all 69** unmatched settlement credits as `UNSPLITTABLE_BATCH`, replacing accurate `MISSING_IN_GATEWAY` exceptions with a proof the engine had not performed. ADR-038's entire content is that unsplittability may be claimed only after genuinely trying; a search over fewer than two candidates is not a genuine attempt at a *batch*. That would have looked like progress — a category moving off 0.000 — while being a straight downgrade in honesty.

  **And then the real finding.** With both guards in place S10 produces **zero** verdicts, because its candidate pool has a maximum size of **1**:

  ```
  gateway rows with NO bank counterpart:
    in a group, matched to ledger only ....... 58   <- EXCLUDED from the pool
    in no group at all ....................... 10   <- the ENTIRE pool today
  ```

  Every one of the six designed `UNSPLITTABLE_NET_BATCH` events has its gateway matched to its **ledger** row, so none can enter the pool. The predicate asks *"is this record in any group?"* where the domain question is *"does it have a **bank** counterpart?"* — **the same record-versus-role error as #40, in a different stage, four days after #40 was fixed and written up at length.** Filed as [#49](https://github.com/flare19/payment-reconciliation-agent-platform/issues/49); it is blocked on #45, because a widened pool means batch findings must merge into existing groups and `roleConflict` refuses multi-role merges unconditionally.

  **What that says about the failure mode.** #40's lesson was recorded as *"two facts in different documents, never composed."* That framing was too narrow. The reusable shape is **record-level reasoning where the domain is role-level** — a category error that has now appeared in Tier 2's pool, in S10's pool, and (as #45) in `roleConflict`'s refusal rule. Writing up an instance is not the same as recognising the class, and the cost of the difference was finding it again by hand.

  **The honest outcome of a wiring day is a stage that runs and a number that did not move.** #46 stays open with four of eight criteria met, and its recall arrives with #49.

  **Day 10, continued — #45 and #49 landed, and S10 finally does something. Two over-claims and one arithmetic slip were caught on the way, all three by measuring rather than by reading.**

  **#45 — rule 3's cardinality exception.** §10 rule 3 has always said `many_to_one` and `one_to_many` groups are *"the sole exception: multiple members of one role are legitimate there, and only there"*, and `roleConflict` never implemented it. The exception is now **declared by the rule that asserts the cardinality** (`mayDuplicateRole`), never inferred from the resulting shape — inferring it would make rule 3 toothless, because every ambiguous second candidate would quietly become a "many_to_one group" instead of an `AMBIGUOUS_MATCH`. Making same-role merges legal also made the cluster-merge branch reachable for the first time, so #45's second half — that branch silently dropping `cb.pairs` — had to land in the same commit. Left alone it would have let a weak `pending_review` pair absorbed into a strong cluster vanish from the merged group's confidence, tier and status.

  **#49 — the pool predicate.** Role-scoped now: *"does this gateway have a **bank** counterpart?"* rather than *"is it in any group?"*. That is the #40 category error, and this was its third appearance.

  **Then three things the measurement caught that reading would not have.**

  1. **A same-source scoring artefact.** A `one_to_many` group's two bank legs produce a `bank↔bank` pair, and `tools/score` counted 15 of them as invented matches — precision would have dropped from 1.0000 for the exact shape §8.1 exists to produce. The key models cross-source pairs; its only same-source entries are the nine `IDENTITY_DESTROYED` gateway↔gateway **denials**, which must stay fully scoreable. So the scorer now excludes unaffirmed same-source legs and **counts the exclusion**, and a test asserts the denials still fire. **A scorer defect that only becomes reachable when the engine starts producing a shape it never produced before.**

  2. **`UNSPLITTABLE_BATCH` at precision 0.067.** With only a pool-size floor, wiring S10 relabelled 17 credits across 15 events as unsplittable batches — one of them a designed batch, fourteen of them ordinary `TIMING_LAG_NORMAL` settlements. **A category moving off 0.000 looked like progress and was a straight downgrade in honesty.** §8 says a batch is *"the net of MANY payments"*, so the discriminator is that the credit must exceed the largest available candidate; with that, precision is **1.000** and recall **0.500**, with the three misses named.

  3. **And the first version of that fix was wrong in a way worth recording.** I required **two** present candidates. §4's `UNSPLITTABLE_NET_BATCH` is a credit netting payments *"with no breakup file provided"*, and the generator proves unresolvability over the payments that ARE available — often one. **The floor demanded the very evidence whose absence defines the scenario**, and it took the six designed batches to 0/6 before the measurement said so. Twice in one day, a guard written to prevent an over-claim became an under-claim; both times the fix was to go back to what the spec says the case IS, not to move a number until it looked right.

  **Where the holdout landed:**

  ```
                      before S10    after
  pair recall           658/872    694/872     +36
  cross-source invented     0          0
  one_to_many groups        0          7
  match members           755        773
  exceptions              256        236
  UNSPLITTABLE_BATCH  0.000/0.000  1.000/0.500
  match rate            67.85%     66.48%      -1.37
  ```

  **The match rate went DOWN and that is correct.** A split settlement is `pending_review` (ADR-038: a decomposition is a strong inference, never a certainty), and §10 rule 4 says a group containing a proposal IS a proposal — so seven groups that had been auto-confirmed became pending when their bank legs arrived. **The pairs were found; they are just not confirmed.** That is the found-versus-auto-confirmed distinction ARCHITECTURE §8.1 already documents, showing up in the headline for the first time, and it is the honest direction for it to move.

  **End of Day 10 — the re-score, and three more scorer defects that only S10's new output could reach.**

  ```
                        Day 9      Day 10
  precision            1.0000     1.0000
  recall (confirmed)   0.6173     0.6089
  TP / FP / FN        442/0/274  436/0/280
  pending pairs          150        207
  review-queue prec     0.94       1.0000  (over 183 judged)
  FOUND AT ALL       583 = 81.4%  619 = 86.5%
  unresolvable recall    1.0        1.0
  false-despair         0.78       0.80
  match rate           67.85%     66.48%   ceiling 93%
  build blockers          0          0
  ```

  **The headline fell and the engine got better, and both halves of that are true.** Split legs are `pending_review` (ADR-038), §10 rule 4 makes a group holding a proposal a proposal, so six pairs moved from confirmed to pending — while 51 more pairs were found. Auto-confirmed recall −0.008; **found-at-all +5.1 points**. This is the second day running where the honest headline moves opposite to the honest improvement, and it is the strongest argument yet for publishing both figures side by side rather than one.

  **Three scorer defects, all latent until the engine produced a shape it never had before.**

  1. **A crash.** `scoreResolvability` read `e.evidence['searchExhausted']` from `ExceptionSummary`, which does not carry `evidence` — only `ExceptionDetail` does. It never threw because S10 was unwired and the `UNSPLITTABLE_BATCH` guard always skipped. The first run to produce one died with `Cannot read properties of undefined`. Now read from `runs.metrics`, which S14 computes from the verdicts themselves.
  2. **Review-queue precision applied different exclusions from the primary metric.** Pending pairs on EXCEPTION events counted as wrong asks, reporting **24 bad proposals on a run whose genuinely wrong count is zero** and dragging the queue from 1.0 to 0.88. The queue's exclusions must match TP/FP's exactly, or the two disagree about what a wrong question is. **Correct figure: 1.0000 over 183 judged.**
  3. **A tie-break nobody had chosen.** §5.2 scores classification per EVENT; the engine raises exceptions per RECORD; **40 of ~72 exception events carry more than one category.** The scorer was picking whichever came first in the key's `projections` array — generator output order. Replacing it with canonical row order moved macro precision by 0.08 and took `UNSPLITTABLE_BATCH` from **1.000/0.167 to 0.000/0.000 on identical engine output**. Filed as [#50](https://github.com/flare19/payment-reconciliation-agent-platform/issues/50), P1: it is ADR-072's unit mismatch — the key describes events, the engine reports records — in its other half.

  **The pattern for the day, stated plainly.** Every defect found today lived in a consumer that had never been fed real input: `roleConflict`'s cardinality exception, S10's pool predicate, the scorer's evidence read, its queue exclusions, its category tie-break. **A stage that produces nothing validates every consumer downstream of it, and validates none of them.** Wiring S10 was worth doing for what it broke as much as for the 51 pairs it found.

  **And twice today a guard written against an over-claim became an under-claim** — the two-candidate batch floor, and the canonical tie-break that hides a category the engine gets right. Both times the correction was to go back to what the spec says the case IS. Neither time was it to move a number until it looked better.

  **Last thing on Day 10 — #50 fixed, and the classification figures were wrong the whole time.**

  §5.2 scores classification per EVENT; the engine raises exceptions per RECORD; 40 of ~72 exception events carry more than one category. The scorer had to pick one prediction and the rule for picking it had never been chosen — it was taking whichever exception came first in the answer key's `projections` array, i.e. generator output order. Replacing that with canonical row order was better but still arbitrary, and it read `UNSPLITTABLE_BATCH` as **0.000/0.000** for a category the engine raises on exactly the right credits.

  **The rule was already written down, in `schema.md` §8.2**, and it names this exact case:

  > *"**Unsplittable batch before presence,** for the same reason: its member payments would each otherwise be reported as `MISSING_IN_BANK`, turning one honest exception into five misleading ones."*

  So the scorer now picks an event's prediction by the **engine's own precedence order**, applied across the event's records. It is the engine's stated rule rather than one I invented; it does not consult `expectedCategory`, so it cannot manufacture a hit; and it is order-independent, which the row-order rule only accidentally was.

  ```
                        row order   §8.2 precedence
  macro precision        0.7891         0.9286
  macro recall           0.8024         0.8738
  UNSPLITTABLE_BATCH  0.000/0.000    1.000/0.500
  MISSING_IN_BANK     0.700/0.933    1.000/0.933
  MISSING_IN_LEDGER   0.824/0.933    1.000/0.933
  ```

  **The engine output is byte-identical across those two columns.** Every one of those numbers moved because the measurement changed, and the earlier ones were wrong. A multi-label view is now reported beside the matrix — a category counts if raised anywhere on the event — because the single-label reduction discards what the engine said on more than half its exception events, and hiding that was part of how the problem stayed invisible.

  **What makes this the day's most uncomfortable finding.** Three separate scorer defects landed in one day, all in the module whose entire job is to be trustworthy, and all invisible until the engine produced output it had never produced before. The accuracy table published on Day 9 was not wrong about the engine, but it was wrong about the exception list, and nothing in the suite could have said so. `tools/score` needs the same treatment the engine got: an isolated audit, by someone who did not write it.


- **2026-08-31** — **Day 11: #38 fixed. Anchor agreement had never been compared across key types, so a byte-identical reference sitting on both rows scored zero.**

  `anchorAgreement` in `scoring.ts` compared weak anchor keys **like-for-like only** — `structuredValue(a, key)` against `structuredValue(b, key)` for the *same* key. `bank_ref_no` exists on bank rows and on no other source, so that branch could never fire across sources. A bank row whose `bank_ref_no` was byte-identical to a gateway `rrn` scored `anchor: none` — a literal zero — with a perfect amount, an in-window date and a perfect counterparty trigram, landing at 0.50–0.60 against the 0.65 review floor. Eleven true pairs on the holdout, every one of them in the never-found set: not scored low, never surfaced to a human at all.

  **Recovered by:** a cross-key comparison block in `anchorAgreement` — every structured STRONG anchor on one side against every structured WEAK anchor on the other, both directions, scored `strong_weak` (0.30). No weight changed. `strong_weak` and not `weak_weak` because the block immediately above already grants 0.30 when a structured anchor matches a value **regex'd out of a free-text description blob**, and a value the source stated in a structured column of its own is strictly better evidence than that. Paying it less would have inverted the ordering; paying it nothing, as it did, inverted it completely.

  **The measurement, on byte-identical inputs:**

  ```
                        Day 10     Day 11
  precision            1.0000     1.0000
  false positives          0          0
  recall (confirmed)   0.6089     0.6075
  TP / FP / FN        436/0/280  435/0/281
  pending pairs          207        230
  review-queue prec  1.0 (n=183) 1.0 (n=206)
  FOUND AT ALL       619 = 86.5% 641 = 89.5%     +3.1 pts
  match rate           66.48%     65.22%         -1.26
  match members          773        784
  exceptions             236        214
  audit entries          615        593
  MISSING_IN_BANK         51         40
  MISSING_IN_GATEWAY      70         58
  unresolvable recall    1.0        1.0
  false-despair         0.800      0.816
  classification    macro 0.9286 / 0.8738 — unchanged in every cell
  build blockers           0          0
  ```

  **Third day running that the headline moves opposite to the improvement, and the reason is the same one both previous times.** Seven of the eleven recovered pairs score in the 0.65–0.849 review band; §10 rule 4 makes a group holding a proposal a proposal, so seven groups that had been auto-confirmed became `pending_review` and took their already-counted legs out of the headline with them. One pair moved from confirmed to pending, which is the whole of the −0.0014 in auto-confirmed recall. **Twenty-two more pairs are located and every one of them is correct** — review-queue precision is still 1.0000 over 23 more judged proposals. If ARCHITECTURE §8.1's found-versus-confirmed framing needed a third witness, this is it.

  **A second-order effect worth naming, because it looks like a regression and is not.** `UNSPLITTABLE_BATCH` went 3 → 4 and `batchSearchExhausted` 3 → 4. One bank credit (`bank:51`, LENSKART, ₹3,01,719.78) was classified `MISSING_IN_GATEWAY` before and `UNSPLITTABLE_BATCH` after. Nothing about that credit changed — a gateway payment in its S10 candidate pool acquired a bank leg through the new cross-key anchor and therefore left the pool, which changed the answer S10's bounded search returns for it. The category moved from *"no gateway row found"* to *"the engine tried to decompose this credit and proved it could not"*, which is `schema.md` §8.2's precedence working exactly as written and is strictly more useful to a human. Classification precision and recall did not move in any cell.

  **What the fix deliberately does NOT do, both decided on evidence rather than symmetry:**

  1. **A strong-key contradiction still discards the pair**, whichever weak key agrees — `bank_ref_no` is documented as *sometimes* equal to the RRN, so a coincidental agreement must never outvote two ids that positively disagree. A consequence, asserted in a test rather than left to be discovered: a **near-anchor** is by construction two values of the same key that differ, so wherever a near-anchor exists the cross-key block stands down. That costs nothing measurable — bank rows carry no structured strong anchor at all (AUDIT-1), so a gateway↔bank pair has nothing to contradict with, and zero holdout pairs exercise the interaction.
  2. **weak↔weak across different keys is not granted.** A gateway `order_id` equal to a bank `bank_ref_no` is the symmetric case and the issue explicitly asked for it to be decided on evidence. It occurs **zero times among the holdout's 26,908 candidate pairs**, so granting it would add an inference path nothing exercises. Left out, and said so — in a test, so the decision is visible rather than absent.

  **Why 486 passing tests never caught this.** The same shape as #30, #31 and #40: `scoring.ts` was correct against every worked example in `schema.md` and had a guard test protecting the ADR-030 ceiling, and the ceiling was never what was wrong. The defect was in a comparison that *doesn't happen*, and no test can assert the absence of a comparison nobody thought to write. What made it findable at all was the answer key — the pair recall figure is the only artifact in this project that can say "there are eleven relationships here that you did not find", and the only reason it could name them was that #46 had already cleared the other 48 out of the way.

  **Fourteen pinned test literals moved, across five files.** Every one was checked against a before/after run rather than pasted from a failure message, and each delta reconciles arithmetically with the eleven pairs: +11 match members, +11 three-way groups, +22 implied pairs, −22 exceptions, −22 audit entries, −9 `MATCH_CONFIRMED_EXACT` (§10 rule 5 reporting a group at its weakest tier), +7 `MATCH_FLAGGED_FOR_REVIEW`. **A pin updated to whatever the run printed is not a passing test, it is a recording.** The three new positive assertions in `scoring.test.ts` were verified to FAIL with the fix reverted before they were kept.

  **Later on Day 11 — attributing the residual gap, and what it says about "65% against a 93% ceiling".**

  The headline invites the wrong reading, so here is the decomposition, measured rather than asserted:

  ```
  reconcilable records          874
  auto/human confirmed          570 = 65.22%   <- the headline
  pending_review                214 = 24.49%   <- found, correct, awaiting a human
  IN A GROUP AT ALL             784 = 89.70%
  ceiling (93%)                 813
  genuinely not located          29 =  3.32 pts
  ```

  **Of the 27.78-point gap between the headline and the ceiling, 24.49 points is the review queue** — records the engine located, whose proposals are correct at **1.0000 precision over 206 judged pairs**, and which ADR-040 deliberately keeps out of the headline because a human has not confirmed them. **3.3 points is the engine actually failing to find something.** The headline is not a measure of how much the engine found; it is a measure of how much it will assert on its own, and those are different numbers by design.

  At pair level: 716 scorable true pairs, 435 confirmed, 206 pending, **75 never found**. Attributed one by one:

  ```
  no shared reference value, bank<->ledger ....... 37   correct refusal (ADR-064/075, see #48)
  no shared reference value, gateway<->bank ...... 20   correct refusal (ADR-030 ceiling)
  no shared reference value, gateway<->ledger .... 13   correct refusal
  share a reference value, NOT matched ............ 5   ACTIONABLE -> #51
  ```

  **70 of 75 are the engine declining pairs that share no identifier at all**, which is the ADR-030 honesty property doing exactly what it exists for. Matching them would require guessing from amount, date and name — the coincidence generators — and a run that did so would raise the match rate and lower the thing the rate is supposed to stand for.

  **The remaining 5 are one defect, filed as [#51](https://github.com/flare19/payment-reconciliation-agent-platform/issues/51), and it is the third instance of one family.** `batch-stage.ts` offers the split pass only gateway records with *no* bank counterpart (`openIn('gateway','bank')`). A split settlement is one gateway payment across N bank credits — so the moment S9 accepts any single leg, the record leaves the pool and `findSplitSettlement` is never asked about the rest. **7 of 9 split events assemble fully; the 2 that do not are exactly the 2 where S9 found a leg first.** Which of the nine assemble is decided by a race between S9 and S10 rather than by evidence.

  ```
  #40  Tier 2 excluded whole RECORDS where §6.3 excludes PAIRS
  #49  S10 asked "is this in any group?" where the question is "a counterpart in this ROLE?"
  #51  S10's SPLIT pass asks "a counterpart in this role?" where the question is "is this role COMPLETE?"
  ```

  Each time a presence test stood in for a more specific question; each time it removed records from a stage's domain silently rather than erroring. **And each was found only by attributing misses against the answer key, never by a test.** The scorer is the only instrument in this project that can say "there are five relationships here you did not find".

  **Still Day 11 — #51 fixed, and §8.1's anchor clause turned out never to have fired at all.**

  Filed as "the split pass is gated on a role-PRESENCE test". That was true and it was half the defect. The other half only appeared once the gate was opened: the two events still refused, now with all their legs in the pool.

  ```
  gateway:250   net 19,386   settlement_id setl_X6oDB8pVLveGk2   rrn 579481974116
    bank:290 = 4,076   bank:39 = 5,485   bank:238 = 9,823   bank:296 = 2
    every leg: bank_ref_no = 579481974116, description carries setl_X6oDB8pVLveGk2
    sum = 19,386  — EXACTLY the expected net
    verdict before: none  ("at least two combinations sum to this credit")
  ```

  The second combination is the same four legs minus the **2-paise** one: 19,384, also inside a ±100 paise band. **The tolerance that exists to absorb fee rounding was deciding membership**, while a settlement id sitting on all four rows went unread.

  **Why it went unread is the finding.** §8.1 says *"group unmatched bank credits **sharing an anchor with the gateway record**"*, and the implementation tested `sharedStrongAnchor` — structured strong keys, like-for-like. AUDIT-1 established on Day 6 that **bank rows carry no structured strong anchor at all.** So that test was always `null` on real data, every leg was admitted on the date window alone, and **§8.1's anchor clause had never fired once since the day it was written.** Same blindness as #38, one module over, found the same way: by asking why a specific true pair was missing.

  **Fixed in three parts, all of which are needed — any one alone leaves the events half-assembled:**

  1. **The gate.** A gateway record is offered to the split pass while its bank role is *open* — empty, **or** filled by legs that sum short of the payment. Presence was the wrong test for the one rule whose subject is having more than one leg. Already-matched legs join the search pool, and the accepted solution must contain them.
  2. **Admission.** `sharedStrongAnchor` **or** `sharedReferenceValue` — the cross-key notion #38 established, now extracted into `anchors.ts` with a warning block so S9 and S10 cannot drift and S4/S6/S7/S8 cannot call it. Where ≥2 reference-bearing legs sum into the band, **that set is the split**; arithmetic proves the sum instead of choosing the members. The subset search is untouched for legs carrying no reference.
  3. **Emission.** Every leg is emitted as a split pair, including one a tier already matched, and that tier pair is superseded. §10 rule 3 admits several members of one role only through pairs that DECLARE the exception (ADR-077) — so a non-declaring fuzzy pair beside three declaring ones is refused as `AMBIGUOUS_MATCH` and **its leg is thrown out of the group the stage just proved.** That is exactly what happened to `bank:290` and `bank:253` on the first attempt, and it is why 7/9 became 8/9 and not 9/9 until this landed.

  ```
                        before #51   after
  split events assembled     7/9      9/9 by the rule, 8/9 end to end
  match members              784      789
  FOUND AT ALL         641 = 89.5%  648 = 90.5%
  pending pairs              230      246
  review-queue precision  1.0 (206) 1.0 (213)
  precision / FP          1.0000 / 0  1.0000 / 0
  exceptions                 214      212
  MISSING_IN_GATEWAY          58       53
  MISSING_IN_LEDGER           63       66
  tierAttribution batch       18       25
  match rate               65.22%   65.22%
  classification    macro 0.9286 / 0.8738 — unchanged in every cell
  ```

  The ninth split is short one **ledger** row that no tier ever matched — a gateway↔ledger miss, not a split one. `MISSING_IN_LEDGER` rising by 3 is the five newly-grouped bank rows correctly changing which role they are missing.

  **The pattern, now at four instances and worth stating as a rule.** #40, #49, #51's gate and #51's admission are all the same mistake: **a cheap test standing in for the question actually being asked, and failing SILENTLY by removing things from a stage's domain rather than erroring.** Records vs pairs; any group vs this role; a counterpart in this role vs this role being complete; a strong key vs a shared reference value. In every case the code was defensible line by line, the tests passed, and the only instrument that could see the loss was the answer key.

  **And a rule for the next one:** when a predicate names a *property of a record* but the rule around it is about a *relationship between records*, that is the smell. All four were that.

  **End of Day 11 — the LLM provider changed, and one locked design assumption did not survive it.**

  There is no Anthropic API key for this build, so both LLM surfaces move to **Gemini** on the free tier: `gemini-3.5-flash` for the explain layer, `gemini-3.7-flash` for the Analyst, one `GEMINI_API_KEY`, `@google/genai`. ADR-080. Nothing broke — but scoping it surfaced two things worth recording before U11 starts writing against them.

  **1. `AGENT_MAX_COST_USD_PER_RUN` was the wrong bound and nobody had noticed, because it had never been tested against a free tier.** A cost ceiling protects a credit card. A free-tier key has no bill to cap, and its scarce resource is **requests per day** — so a run that dutifully stays under $1.00 can still exhaust the entire daily quota and leave the deployed demo dead until it resets, with no way to pay to reopen it. On submission day that is the failure that matters, and it was not bounded at all. `AGENT_MAX_LLM_REQUESTS_PER_RUN` (default 220 — 20 investigations × ~10 steps plus headroom) is now counted and enforced whether or not the key is billed.

  Worth naming as a class: **a bound is only a bound against the failure it was written for.** ADR-057's ceiling was written when the risk was a surprise bill; the risk is now a dead demo, and the same number does not cover both.

  **2. Two documents leaned on Anthropic prompt caching for their cost argument** — `schema.md` §10.3's *"cacheable prefix"* and `agent-design.md` §8's *"that is the difference between an affordable phase and an expensive one."* Gemini does not offer that mechanism in the same form, so both claims are now removed rather than quietly reinterpreted. The good news is that neither design actually needed it: the explain layer's economy is ADR-018's **signature collapse** (~75 exceptions → 15–30 signatures → ≤8 requests), which is a property of the batching and holds on any provider; and §8's bounds are step, tool-call, wall-clock and request ceilings enforced between turns, not cost estimates. **The arguments survive; the sentences that rested on a vendor feature do not.**

  **One thing deliberately NOT written down: a rate-limit number.** Google's rate-limit page defers to AI Studio for per-key figures and the third-party summaries contradict each other by an order of magnitude. An unverified number inside a locked document is worse than a stated absence, so the design is built not to need one — 8 requests per run for explain, 220 for Phase A, and honest degradations (`explanation_source = 'template'`, `INSUFFICIENT_EVIDENCE` with `budgetExhausted`) on either side of a quota wall.

  **And one privacy fact that belongs in the submission rather than a footnote:** free-tier content is used to improve Google's products. For the explain layer that is a non-issue **by construction** — ADR-018 sends only the signature, with no amounts, no ids and no merchant names. Phase A is different: its tool results carry real record data. This dataset is synthetic, which makes the free tier acceptable here and nowhere else.

  **Last thing on Day 11 — the Analyst was pointed at the wrong pile, and nobody had noticed because the right pile is not the one the track names.**

  Phase A was designed entirely against the **exception list**, because that is the feature the track grades. A run also leaves a **review queue**: matches the engine found, scored into the 0.65–0.849 band, and correctly declined to auto-confirm. On the holdout that is **71 groups covering 214 records — 24.5 points of the reconcilable population, at a measured review-queue precision of 1.0000 over 213 judged pairs.** Nothing in Phase A looked at any of it.

  That was an accident of framing rather than a decision, and it hid the sharpest asymmetry in the design: an Analyst proposal a human accepts becomes a **`manual`** match, which ADR-043 and ADR-051 exclude from the engine match rate — so the Analyst as designed could *never* move the headline. A **pending** match a human confirms becomes **`human_confirmed`**, which ADR-040 counts. **The one Analyst surface that can move 65.22% is the one it was not looking at.**

  ADR-081 adds it, with the line drawn where ADR-017 requires: **the agent never recommends confirming or rejecting.** `CONFIRM_RECOMMENDED` was the obvious verdict shape and is the wrong one — a model answering "should this be confirmed?" fifteen times is deciding, whatever the field is called. It answers a different question it can actually source from tools: *is there evidence the scorer did not use?* — `CORROBORATED` / `CONTRADICTED` / `NO_NEW_EVIDENCE`, every one cited and checked by the A3 grounding gate. A human still clicks.

  **The measurement is unusually sharp and that is the point.** Because the queue's engine-side precision is a clean 1.0000, **every `CONTRADICTED` verdict is measurably a false alarm** — there is nowhere for a wrong answer to hide. An agent manufacturing doubt to look useful shows up on the first run.

- **2026-08-31 — overnight P2/P3 sweep, branch `day12-p2p3-sweep`.** Ten backlog issues attempted, all ten landed as real fixes — no engine output moved and no pinned literal changed (verified: `npm run typecheck` and `apps/api`'s unit suite — 424 → 430 — plus the root `tools/` suite at 235, all green; integration tests need Postgres, unavailable here, so `routes.test.ts`'s two edits are typecheck-verified only, not run).

  **#9 — `tests/` was never typechecked, and one assertion could not fail.** Added `tsconfig.test.json` (tests/** included, build config stays src-only) and pointed `npm run typecheck` at it. Turning it on immediately surfaced five real type errors `tsx`'s strip-only transform had been hiding for who knows how long — a `classification.test.ts` assertion matching `undefined ?? severity` against `/.*/` (replaced with the category/secondary-flag/candidatesConsidered it actually produces), a fixture missing two `RunRecordCounts` fields, three possibly-undefined index reads, two `string|null` args, and a `pipeline()` return type that silently dropped its own cast. All five were test-file-only; nothing in `src/` changed.

  **#44 — three tests whose titles claimed more than their assertions checked.** Two of the three findings were real: the manual-match test picked two `MISSING_IN_BANK` gateway records, which (structurally, since Tier 1 only ever matches gateway↔ledger) are routinely already matched — the POST reliably hit 409 and `tier === 'manual'` had zero coverage. Switched to two excluded (never-matched) records, making the 201 path deterministic and removing the `if/else`. The third finding (the recall test enumerating every shortfall by cause) turned out to be **already fixed** in a prior commit — `tier2-groups.test.ts` already attributes every miss to a named, exact-count cause. Said so rather than re-doing it.

  **#33 — same pattern, Tier 1's own recall test.** `matches.length > 150` had 44 matches of headroom, enough to hide #30's 9 `REFUND_REVERSAL` misses entirely. Replaced with a real recall assertion against the answer key's `viaTier: 'exact'` gateway↔ledger pairs (210 today, not the stale count from when #33 was filed) and an enumerated-cause classification of every miss: **9 are `AMOUNT_TRUE_MISMATCH`**, correctly left to S8; **9 are non-primary exact duplicates dedupe drops from the pool before Tier 1 runs** — a `DUPLICATE_RECORD` class this suite had never named before, only visible once the whole miss set was enumerated instead of floored.

  **#11 — the searchExhausted/searchBoundExceeded exclusivity test built a fixture that already satisfied what it was testing.** The real invariant lives in `searchSubsetsInBand`, not in `classify.ts` (a straight passthrough). Added a property test directly against `searchSubsets` sweeping pool size/target/tolerance/node budget, and replaced the classify-level test with one that feeds a genuinely contradictory stats object and asserts classify passes both fields through unchanged — proving it as a passthrough rather than pretending it enforces something it doesn't.

  **#13 — `domain.ts`'s header claimed every union mirrors a CHECK constraint in both directions; it doesn't.** `PaymentMethod`/`BankTxnType` back plain-TEXT columns with no CHECK (schema.md already said so correctly), and three CHECK constraints have no TS union. Comment-only: narrowed the claim and named both exceptions and why they still matter.

  **#24 — `appendAuditEntry` would throw on a NUL or an unpaired surrogate in the very record it was trying to log.** Postgres's jsonb parser rejects both even though `JSON.stringify` produces well-formed JSON text for them. `canonicalJson` now sanitizes every string (and object key) before serializing — NUL stripped, an unpaired surrogate becomes the replacement character — running BEFORE hashing so the hash and the stored bytes agree, the same way key-order and date normalisation already do. `reason` (a plain TEXT column that bypasses `canonicalize` at write time but is still walked when the whole entry is hashed) is sanitized identically in `toStoredForm`, or the hash and the actual SQL parameter would silently diverge. A no-op for any string that doesn't contain one, so no existing hash changed. Not exercised against a live INSERT here — no Postgres — verified at the `canonicalJson`/hash-chain unit level, which is where the throw actually originates once a database is involved.

  **Review, same morning — one change was reverted before merge, and it is the most instructive thing here.** The #25 commit also edited a comment inside `apps/api/migrations/007_audit_log.sql`. `db/migrate.ts` **checksums every migration file** and turns any change into a startup failure — comments included — so that one-line comment made every already-migrated database refuse to boot, with the error reading *"Migrations are forward-only: add a new migration instead of editing this one."* It broke all five integration suites (93 tests) and, with `RUN_MIGRATIONS_ON_BOOT=true` as the default, would have taken the API down on Railway the moment U14 deployed.

  **The unit suite was green the whole time.** The sweep ran in a cloud environment with no Postgres, correctly said so rather than implying integration had passed, and still could not have caught this: it is precisely a defect that only exists once a database remembers what it already ran. The clarification it was adding was already stated in `hash-chain.ts` and `schema.md` §9.0 by the same sweep — two better places — so reverting cost nothing. **Every other change was verified against a real database and a full scored run: 523/523 tests, and byte-identical engine output** (284 matches, 212 exceptions, 591 audit entries, match rate 65.22%, tier attribution unchanged).

  **#28, #25, #27, #10 — four doc-vs-code contradictions, all docs-only (plus two one-line, non-functional code comments).** `api-contract.md` described a `ChainVerification` response that matched neither itself (§1 vs §22) nor the code (missing `divergenceKind`/`anchored`/`expectedEntryCount`/`expectedChainHead`, and a `verifiedAt` the endpoint has never produced) — reconciled to the real 8-field shape (#28). `schema.md` §9.0, migration 007's comment and ADR-042 all said the hash excludes two fields; `hash-chain.ts`'s `strip()` — already correct — excludes three (`sequence_no` too, DB-assigned at INSERT). Named all three everywhere and appended **ADR-082** (#25). `schema.md` §9.0 still claimed "no concurrent-append race to resolve" via a single-writer assumption Unit 9's advisory lock made obsolete by design; rewrote it to describe the actual per-chain `TxClient`-scoped lock (#27). `matching-engine.md` §7.3 said the ambiguity guard runs AFTER assignment ("even if step 3 happened to assign it one of them") while `schema.md` §5.4 and the code (unchanged, already correct) run it BEFORE assignment and block the slot — fixed the doc and appended **ADR-083** (#10).

  **The pattern worth naming:** every one of the ten was either a test that could not fail, or a doc that disagreed with already-correct code. Not one required changing what the engine does. That is exactly the shape a P2/P3 sweep should have — the load-bearing defects get found by audits and answer-key measurement, and what is left is the credibility debt of tests and docs that stopped being true days ago and nobody re-checked.

- **2026-08-31** — **Day 11, U11: the explain layer (S13) is wired. The last unwired stage is gone, and `stagesNotRun` is empty for the first time.** Branch `day12-explain-layer`.

  **What the run does now.** 212 exceptions collapse to **21 distinct discrepancy signatures**, each one gets text, and `explanation_text` is never null. There is no `GEMINI_API_KEY` on this build, so all 21 resolve to hand-written templates and every exception carries `explanation_source = 'template'` and moves `open → explained`. That is the path ADR-017 requires to work and it is the one that actually runs here — the model path exists, is unit-tested against a fake client, and has never made a live call.

  **The number that moved, and exactly why.** The audit chain went **591 → 612**. The `+21` is not a coincidence and is not "roughly one per exception": it is *exactly* the distinct-signature count, because **the explain decision is made once per signature** — call the model, reuse the cache, or take the template — and then fanned out to every exception wearing that signature. One entry per *exception* would have added 212 and been transcription, which is the line `orchestrator.ts` already draws for ingestion (one entry per source, not per row) and that §9.1 draws by flooring `MATCH_CANDIDATE_REJECTED` at 0.40. The integration test now asserts `explainEntries === distinctSignatures` rather than pinning `21` alone, so the *reason* is what fails if it drifts.

  **What did NOT move, verified the only way worth trusting.** A `git worktree` at `main`, a holdout run through the pre-U11 engine, and `npm run score` against both runs: **the two score reports are byte-identical.** precision 1.0000 · FP 0 · recall 0.6075 · macro P 0.9286 / R 0.8738 · unresolvable recall 1.0 · match rate 65.22% · `tierAttribution {exact 203, fuzzy 277, batch 25, implied 242}`. Diffing two scorer outputs is a much stronger claim than re-reading a number out of `CLAUDE.md`, and it caught nothing — which is the result.

  > **A number in `CLAUDE.md` was stale and would have read as a regression.** §10 records `recall 0.6089` from Day 10. The current figure is **0.6075**, and it is 0.6075 **on `main` too** — #38 and #51 moved pairs into the review band after that line was written (§10 rule 4), and the headline recall was never updated with them. Had I compared against the doc instead of against `main`, I would have spent the evening hunting a 0.0014 regression that U11 did not cause and that is not a regression at all. Corrected in §10 in this commit.

  **The design decision that took the longest, and the failure it prevents (ADR-084).** `explanation_cache` is deliberately **run-independent** — it outlives the run that wrote it, which is the whole of ADR-018's economy. So if S13 had cached *template* rows, the first keyless run would have written all 21 signatures as cache entries, and every later run — **including runs that do have a key** — would have served them as hits. The day a key was finally added, the explain layer would have kept emitting templates labelled `explanation_source = 'llm_cache'`: prose attributed to a model that never wrote it, in the artifact a panelist reads, with nothing in the output saying so. Only fresh model output is cached now. What made this worth an ADR rather than a comment is that `schema.md`'s own column annotation reads the other way (`tokens_in` — *"NULL for template-sourced rows"*), so a future session finding templates absent from the cache would otherwise have "fixed" it straight back in.

  **Two more things the spec did not settle, both decided in the direction that makes the advertised bound true.**

  1. **A retry counts against `LLM_MAX_CALLS_PER_RUN`.** §10.3 caps calls at 8 and §10.4 grants one retry on malformed JSON, and the two together are ambiguous. If retries were free, a "hard cap" of 8 would permit 16 requests — and on a free-tier key the binding resource is **requests per day**, not dollars (ADR-080 consequence 2), so the doubling lands exactly on the thing that can kill a submission-day demo. `explainBatch` returns `requestsMade` on *both* its success and failure arms so the driver debits what was actually spent.
  2. **…which then exposed an off-by-one in my own first version.** Checking the budget only *before* each batch still let the last permitted batch spend its retry, so a cap of 8 could spend 9. Fixed by passing the remaining budget INTO the client, which bounds the retry as well as the first attempt: the final batch forgoes its retry and takes the template floor, which is the outcome the cap already promises. Caught by writing the test that asserts `maxRequests` arrives as `[3, 1]` and not `[3, 3]`.

  **A test fixture that was wrong in an instructive way.** My first driver tests built 100 exceptions by incrementing `candidatesConsidered: 0..99` and asserted 100 distinct signatures. They produced **four** — because `candidateCountBucket` collapses that field to `0 | 1 | 2_3 | gt_3`, which is precisely what the module exists to do. Five tests failed and every one of them was the fixture, not the code. The replacement walks a mixed-radix cross product of the four components that genuinely vary (8 categories × 3 anchor strengths × 4 candidate bands × 2 alias states = 192) and asserts the group count up front, so a fixture that stops producing distinct shapes fails loudly instead of quietly testing nothing. **This is the sixth instance in this log of a test whose name claimed more than its assertion** — and the first where the bug was that the code worked *better* than the test assumed.

  **One structural decision worth recording because it is invisible in the diff.** S13 is the only stage that awaits the network, and its reads and model calls happen **outside any transaction**; only the writes are wrapped. Every other phase opens its transaction first. Had this one followed that pattern, `appendAuditEntry`'s transaction-scoped advisory lock on the run's chain would have been held across up to eight 20-second HTTP round trips — blocking every other append and sitting exposed to a managed-Postgres idle-in-transaction timeout on Railway, the platform U14 deploys to. The cost of the split is stated rather than hidden: a crash between the model call and the write loses the prose and leaves the exceptions at `open`. That is the correct direction to fail, because a re-run regenerates it and S13 changes no decision.

  **Verified:** 579 tests in `apps/api` (481 unit + 98 integration, from 523) and 235 at root, all green against a real Postgres 17; typecheck and both builds clean; chain valid **and** anchored at 612; `explanation_cache` empty after a keyless run; `npm run score` exit 0 with every honesty gate passed, posted to `score_reports`.

- **2026-08-31** — **Day 12, U12: the Analyst's tool registry. Nine read-only tools, and the read-only claim is now enforced by Postgres rather than by this repo's good intentions.** Branch `day12-explain-layer`.

  **The thing worth reporting is not the nine tools. It is that "read-only" stopped being a word.** `agent-design.md` §4 has always promised the agent *"is not trusted not to write — it is unable to."* Every implementation I sketched made that a **claim**: a `readOnly: true` flag on each tool, a naming check, a review habit. All three are properties of code someone can change. Every tool handler now runs inside `withReadOnlyTransaction` — Postgres `BEGIN TRANSACTION READ ONLY` — so an INSERT/UPDATE/DELETE reached from any tool fails with **SQLSTATE 25006** whatever the calling code believes it is doing, *including through a repository function that was read-only when the tool was written and is not any more.* A test asserts the throw rather than assuming it. That is the only one of the three guards that survives a future edit by someone who has not read ADR-051.

  **The gap that guarantee still has, and the guard that closes it.** A read-only transaction only constrains queries issued on the client it yields. A tool calling `getPool()` directly — or calling a repository function *without passing the client*, which falls back to the pool internally — escapes into autocommit with full write access, **and every test would still pass**, because the tools being tested happen not to write. So there is a structural guard: no module under `services/agent/` may contain SQL DML, import a mutating repository function, or reach the pool; and every repository call in the registry must pass the client. I verified that last one **fires** by deleting a single `, c` argument and watching it fail — a guard nobody has watched fail is indistinguishable from one that cannot.

  > **`getCachedExplanation` is on the mutating-function denylist, and it is the interesting entry.** Its name reads like a lookup. It is an `UPDATE … SET hit_count = hit_count + 1 … RETURNING`, because U11 wanted the read and the counter in one round trip. A read-looking name that writes is exactly the trap a denylist built from intuition would miss.

  **A stale doc line that turned out to be a design bug (ADR-085).** `CLAUDE.md`'s plan flagged that §4 still described `rerun_subset_search` as *"the same S10 meet-in-the-middle"* — ADR-060 replaced that with depth-first — and asked for a doc fix. Fixing it exposed the real problem one column to the right: the tool signature let the agent pass **`budgetMs`**. That would put the operative bound back on the **wall clock, inside the evidence a reasoning chain cites** — and `searchExhausted` vs `searchBoundExceeded` are different claims *about the data*, so deciding between them by hardware speed is precisely the defect ADR-060 removed from S10. §5's entire payoff is the upgrade: *"exhaustive at wider bounds"* is worth saying only if a second machine reproduces it. The tool now widens a **node budget**; the 2 s valve stays a valve. **The word was stale for one reason and wrong for a much better one.**

  The ceiling is **5,200,000 nodes**, and unlike ADR-063's engine figure it is explicitly **not** a dominance proof — at pool 64 / subset 10 the declared space is ~1.5e11 and no budget covers it. It is derived from the opposite constraint: the node budget must stay small enough that **the safety valve never fires**, because the moment the valve can fire the machine-dependence returns through the back door.

  **A latent bug in a guard, surfaced by a correct value.** `adr-060-doc-sweep-guard`'s pattern `/200,000|200k nodes/` matched **inside** the new `5,200,000`, so a correct ceiling tripped a stale-figure check. The tempting fix — pick a rounder number — would have left the guard broken for the next person; the tempting second fix — delete the pattern — is how a stale-figure check dies quietly. Fixed with a boundary, plus a test asserting all three patterns still **fire** on the figures they exist to catch.

  **Two scoping decisions, deliberately opposite, and the asymmetry is the point.** Every transaction/exception lookup is scoped to one `run_id` — an agent investigating run A must not be able to *retrieve*, and therefore cite, a record from run B, and the WHERE clause is the cheapest place to make that impossible. `find_similar_exceptions` is deliberately **not** run-scoped: a human resolution recorded on a previous run is exactly the institutional memory the tool exists to surface, and confining it to the current run would return only what the agent can already see. Widening the READ does not widen what a verdict may CLAIM, because citations are gated by A3 over tool results.

  **`returnedIds` has to be complete AND minimal, and both directions are failures.** It is A3's grounding allow-list. An id shown to the model but not recorded makes a *truthful* citation look invented and inflates the grounding-failure count that §7 reads as "the prompt needs work". An id recorded but not returned launders a hallucination into an accepted verdict, and A3 cannot tell. Every tool derives it from the payload it is about to return, never from its own arguments — an argument is what the model *asked for*, not what it was *shown* — and a test asserts every returned id actually appears in the payload JSON.

  **Verified:** 633 tests in `apps/api` (from 593) and 235 at root against a real Postgres 17; typecheck and build clean. `score_pair` is asserted to agree with `scorePair` **component for component across 144 real pairs** — if it ever diverges, the agent is citing a number the engine never computed. A full holdout re-score is **byte-identical** to the U11 one: precision 1.0000, FP 0, recall 0.6075, match rate 65.22%, 612 audit entries, exit 0.

  **Also noticed, and now filed as a P1 — [#52](https://github.com/flare19/payment-reconciliation-agent-platform/issues/52).** A `GEMINI_API_KEY` is now present in `apps/api/.env`, so `/api/health` reports `llmConfigured: true` where it reported `false` earlier today. No live call has been made from this session, and every test still exercises the template path because they call `executeRun` without explain deps — but the live path is now REACHABLE and has never been run.

  What that makes urgent is a gap I flagged during U11 and deliberately did not fix: **S13 has no grounding check.** Phase A treats a hallucinated specific as a build blocker (ADR-053). S13 — the layer whose prose a panelist actually reads — relies entirely on a prompt instruction (§10.4 rule 2, "never invent amounts"). The inference is unusually clean and that is what makes it worth a P1 rather than a P2: ADR-018's signature is bucketed by construction and a test already asserts no long digit run reaches the prompt, **so any rupee figure, date or reference id in S13's output is *necessarily* fabricated.** There is no legitimate way for one to be there. `parseResponse` validates shape only; the text is written straight to `explanation_text` and into the exception list, and because `explanation_cache` is run-independent, one fabricated figure is then served to every later run sharing that signature with a `hit_count` that makes it look well-established. A handful of regexes and a template fallback closes it.

- **2026-08-31** — **Day 12, the first keyed run: S13's live path executed for the first time, and it exposed a bound I had picked without measuring.**

  A real `GEMINI_API_KEY` went in, so the model path that had existed since U11 — unit-tested against a fake client, never once executed — finally ran. **It half-worked, and the half that failed was mine.**

  **What happened.** 21 signatures batch into 10 / 10 / 1. Two of the three batches came back `"This operation was aborted"` — my own `AbortSignal.timeout`. The run completed correctly with **20 of 21 signatures served from templates**, `explanation_source` reading `template` for 211 of 212 exceptions, and every engine number untouched. The degradation worked exactly as ADR-017 requires; what it was degrading *from* was a working API.

  **`REQUEST_TIMEOUT_MS` was 20,000, and there was nothing behind that number.** I wrote it as a demo-safety bound — "a hung connection must not stall a run in front of a panel" — and picked 20s because it sounded obviously sufficient. Measured afterwards on `gemini-3.5-flash`, full 10-signature batches: **9.8s / 10.7s / 9.7s / 9.5s** at ~900 output tokens each, and 9.2s for a 2-signature batch. Three fired back-to-back showed no throttling, so the median is ~10s and the two aborts were ordinary latency variance against a bound sitting only **2×** above the median.

  **The lesson is not "20s was too small". It is that a timeout is a threshold on a distribution, and I had measured neither.** Every other bound in this repo is derived — ADR-063's node budget is a proof about the declared space, ADR-085's ceiling is derived from the safety valve it must not trip. This one was a guess wearing the same clothes. Raised to 60,000 with the measurements written into the comment, and the argument stated as a **ratio** (~6× the median) rather than a number, because the number is worthless to the next person and the ratio is not. 60s is also not a new magnitude here — `AGENT_DEFAULTS` already bounds an investigation at exactly 60,000 ms.

  **What a timeout does when it is too tight is the worst thing a timeout can do:** it converts a working response into a silent fallback. Nothing failed. The run completed, every exception had prose, the score was unchanged, and the only evidence was `signaturesTemplated: 20` in a metrics object nobody had a reason to read. **The honest reporting that U11 built is the only reason this was visible at all** — `llmCost.failures` carried two `transport` entries with their detail string, and `explanation_source` distinguished `template` from `llm`. A design that had just written the text and moved on would have shipped this to a panel.

  **After the fix, re-run against the real key:**

  ```
  21/21 signatures GENERATED · 212 exceptions explanation_source = 'llm' · 0 templates
  3 API calls · 2,744 tokens in / 1,745 out · failures []
  audit: 21 EXPLANATION_GENERATED   (one per SIGNATURE, as designed)
  engine: 284 matches · 212 exceptions · 612 audit · 65.22% · 570 matched
          tierAttribution {exact 203, fuzzy 277, batch 25, implied 242}  — UNCHANGED
  score report BYTE-IDENTICAL to the keyless run
  ```

  > **That last line is the point of the whole architecture.** A real language model wrote all 212 explanations and the measured accuracy report did not move by a single character. ADR-017 is no longer a claim about where the LLM sits in the pipeline; it is a diffed artifact.

  **ADR-018's economy, demonstrated live for the first time.** A second identical run made **zero API calls**: 21/21 signatures served from `explanation_cache`, all 212 exceptions `explanation_source = 'llm_cache'`, 21 `EXPLANATION_CACHE_HIT` entries, and the run finished in **~6s instead of ~39s**. "Re-running the full batch is free" stops being an argument and becomes a measurement — which matters because the track disqualifies cherry-picking, and the whole reason to make re-runs free was to remove any incentive not to do them.

  **On [#52](https://github.com/flare19/payment-reconciliation-agent-platform/issues/52), one real data point and no more than that.** Scanning all 21 generated explanations for rupee amounts, reference ids and dates found **zero**. The model rendered bucket labels faithfully into prose — `3_to_10pct` became "by three to ten percent" — which is exactly the behaviour the prompt asks for. That is encouraging and it is **not** a reason to close the issue: one clean sample from one model at one temperature is not a guarantee, and the whole argument for #52 is that the check should not depend on the model's good behaviour. Recorded so the next session knows the current state is "no observed fabrication", not "verified safe".

- **2026-08-31** — **Day 12, the first live investigation. The loop works; three things it exposed did not.** Branch `day12-explain-layer`.

  The Analyst ran against a real model for the first time. What it produced is worth stating before what broke, because the tool use is the part I had least evidence for: given an `UNSPLITTABLE_BATCH`, the agent chose `get_exception` → the engine's own audit trail (twice) → `get_transaction` → `find_by_anchor` twice → **`rerun_subset_search`** → `find_similar_exceptions` → `search_transactions`. That is §5's self-correction pattern — establish which claim the engine is making, then widen the search it admitted running out of room on — and nothing prompted it step by step. **The tool registry is usable by a model, which is not something 33 passing tests could tell me.**

  **1. `gemini-3.7-flash` cannot satisfy the spec that sits beside it (ADR-086).** The first attempt aborted on its first turn against my 90 s client timeout. Isolating it — a bare call, no tools, no history, no schema — reproduced the hang, which ruled out my code and left the model name. Measured, on `Reply with the single word: ok`: **`gemini-3.6-flash` 2.4 s, `gemini-3.7-flash` 53 s**, and 63 s with thinking disabled, so it is capacity rather than reasoning depth. `agent-design.md` §8 bounds an **entire investigation** at 60 s. One turn on 3.7 exceeds the budget for the whole investigation; ten steps would be nine minutes. ADR-080 chose 3.7 from Google's description of it — *"built for complex coding, agentic workflows"* — which is a job description, not a measurement, and neither document noticed the contradiction because neither number existed.

  **2. `thought_signature` — a provider-neutral `{id, name, args}` is not enough to replay a tool call.** On 3.6 the loop reached step 2 and died with a 400: *"Function call is missing a thought_signature in functionCall parts."* Gemini 3.x attaches an opaque signature to each `functionCall` and rejects the next request if the replayed history has lost it. My `AgentToolCall` carried only the three obvious fields, so it was dropped on every replay. **Every multi-step investigation was structurally impossible and every test passed**, because a fake client has no signatures to lose. Fixed with an opaque `providerSignature` the loop carries and never inspects — and this is not a Gemini quirk: Anthropic requires thinking blocks passed back unchanged for the same reason, so the field survives the swap. With it, the same investigation went from 1 step to 9.

  **3. The agent could not see its own budget, so it never stopped.** With the signature fixed it used all ten steps and never wrote a verdict — investigating until the bound cut it off, at which point the verdict becomes `INSUFFICIENT_EVIDENCE` regardless of what it had found. Nine steps of good work, discarded by a bound the model had no way to know existed. Each turn now carries a countdown and the last one forbids further tool calls. Injected as a separate turn rather than edited into the system prompt, so the cacheable prefix stays byte-identical; a test asserts exactly one countdown is present at any time, because nine stale ones each contradicting the last would be worse than none.

  > **THE SAME MISTAKE, THREE TIMES IN ONE DAY, AND I DID NOT SEE THE PATTERN UNTIL THE THIRD.** The 20 s explain timeout, the ceiling-charging triage budget, and `gemini-3.7-flash` were all plausible numbers with nothing measured behind them. Every *engine* bound in this repo is derived — ADR-063's node budget is a proof about the declared space, ADR-085's ceiling is derived from the valve it must not trip — and every bound around the *model* was a guess wearing the same clothes. The asymmetry was invisible because the engine's numbers are scored daily and the model's were not scored at all. **The rule going into the Anthropic swap: a per-turn latency and cost figure is measured against §8's bound before a model is adopted, never read off a description.**

  **Then a `429` ended live iteration** mid-diagnosis. I called it a daily quota; the error text did not actually say so and I had no evidence — see the correction in the next entry, which has the real number. So the budget-pacing fix in (3) is **unit-tested and has never been seen working against a real model** — recorded here rather than implied, because "fixed" and "verified" are different claims and this file exists to keep them apart. The convergence behaviour is the first thing to re-check when quota resets.

  **Where that leaves the baseline.** The Analyst is not yet finished per spec: no investigation has produced a schema-valid verdict, CORROBORATE mode is unbuilt, and the Analyst has never been scored against the answer key. The plan is unchanged and was the right one — finish on the cheap tier, branch, then swap — but the baseline it is meant to produce does not exist yet.

- **2026-08-31** — **Day 12, continued: THE ANALYST PRODUCED ITS FIRST VALID VERDICT.** And getting there cost three more corrections, one of them in a module that had been green since Day 4.

  **First, a correction to the entry above.** I wrote "the free tier's daily quota ran out". The `429` text said only *"You exceeded your current quota"*; I inferred "daily" and stated it as fact. Tejas pushed back — RPM and RPD are different, and if it were RPM we could retry immediately. He was right to push and the retry worked. The real figure, from a later error that carried the detail:

  ```
  quotaId:    GenerateRequestsPerDayPerProjectPerModel-FreeTier
  quotaValue: 20
  model:      gemini-3.6-flash
  ```

  **20 requests per day, per model.** So it *was* daily — but I had asserted it without evidence and happened to be right, which is not the same as having been right. ADR-080 deliberately refused to write an RPD number into the docs because Google's page defers to AI Studio and third-party summaries disagree; the honest move was to measure, and measuring took one request.

  **What that number does to the plan.** One investigation costs 3–10 requests, so 20/day/model is two to four investigations — nowhere near enough to iterate a prompt on. The quota is **per model**, though, and the newer models are the constrained ones: `gemini-2.5-flash` answers a tool-calling prompt in **1.5 s** and has the older generous tier. So loop development moved there. That preserves Tejas's sequencing exactly — iterate on a cheap tier, then swap — it just is not the model ADR-086 named.

  **The gate caught a real hallucination, from a real model, on its first live encounter.** After the pacing fix, `gemini-2.5-flash` jumped straight to a verdict on step 1 and wrote a reasoning step claiming it had called `rerun_subset_search`. It had not. A3 rejected it: *"reasoning step 1 cites tool rerun_subset_search, which was never called"*, and the verdict was downgraded to `INSUFFICIENT_EVIDENCE`. **ADR-050 is no longer a design argument; it is a thing that has now happened and been caught.**

  **My pacing fix had over-corrected, and the second failure was worse than the first.** The countdown urged conclusion from step one, so the model went from *never concluding* to *concluding before it had looked* — and filled the gap by inventing a step. Being cut off loses work; answering early invents it, and only one of those is dishonest. The countdown's tone now tracks the budget: retrieve first, keep going, wrap up, final step. A test pins all four phases.

  **Then a defect in the grounding gate itself, green since Day 4.** `checkSchema` treats an ABSENT `proposedAction` as equivalent to a null one — correctly, because a model omitting an optional-looking field is ordinary. `checkConstraints` guarded only `=== null` and then read `action.type`, so an omitted field **threw**. That is much worse than a rejection: `validateVerdict` is documented to throw only for a *caller* bug, so the loop does not catch it, and **2 of 17 investigations were recorded as failed instead of downgraded**. Fixed to `== null` in both places, with tests in both directions — absent must be handled, and absent must not become a free pass on a `RESOLUTION_PROPOSED`.

  **The first valid verdict, in full:**

  ```
  UNSPLITTABLE_BATCH, engine reported searchExhausted: true
  -> get_exception  ->  CONFIRMED_UNRESOLVABLE, confidence high, grounded, 1 citation
  ```
  > *"The engine's batch search was 'EXHAUSTIVE' and searchExhausted is true. This means the engine proved no combination works within its declared bounds, rather than running out of search room. Therefore, rerunning the subset search with wider bounds is not applicable."*

  That is the right answer **and the right amount of work**. §5 says the agent's job on a dead end is to decide whether the dead end is a property of the data or of the engine's bounds; it decided *data*, from the engine's own evidence, and correctly declined to spend a subset search. The prompt renders `searchExhausted` and `searchBoundExceeded` as different claims precisely so this distinction is available, and the model used it.

  > **A finding about the DATASET that the demo needs to know.** `runs.metrics` reports `batchSearchExhausted: 4, batchSearchBoundExceeded: 0` — every batch search on the holdout terminates with a proof. So **§5's flagship self-correction story has no instance in this dataset**: there is no exception where widening the bounds could find anything, and `rerun_subset_search` can only ever confirm what the engine already proved. The tool works and the agent reaches for it unprompted, but the demo cannot show it *recovering* a batch unless the generator is given a case where the pool cap binds. Recorded now rather than discovered while recording the video.

  **Status.** One valid grounded verdict end to end. A 17-investigation sample was mostly `429` noise (15 of 17 transport failures at ~20 requests/min) and is **not** a baseline — it measured Google's rate limiter, not the Analyst. CORROBORATE is still unbuilt and the Analyst has still never been scored against the answer key.

- **2026-08-31** — **Day 12, end: CORROBORATE landed and the Analyst is feature-complete. It has still never been measured, and that is the sentence that matters.**

  **A2 CORROBORATE required a schema decision nobody had made.** ADR-081 added the review queue as a second work list *after* migration 010 was written, and `agent-design.md` §11 still says "two tables" from before it. So `agent_investigations` could not hold a corroboration: `exception_id` is `NOT NULL` and the verdict CHECK lists only the four investigation verdicts. Migration 013 gives corroborations their own table (ADR-087), and the decisive argument was not tidiness — it is that §7's grounding and hallucination figures are claims about **investigations**, and putting `CORROBORATED` in the same column as `RESOLUTION_PROPOSED` invites a `GROUP BY verdict` that changes what the honesty metric measures without anyone editing the metric.

  **The table has no `proposed_action` column, and that is the enforcement.** §3: *"The Analyst does not recommend confirming or rejecting a match. It never says 'confirm this'."* A table with nowhere to put a recommendation cannot carry one — the same move as the read-only tool registry and `withReadOnlyTransaction`. `rerun_subset_search` is likewise *removed from the registry* rather than forbidden in prose.

  **A test failure turned an accidental mapping into an argued one.** `validateCorroboration` widens a corroboration into `checkGrounding`'s shape as `CONFIRMED_UNRESOLVABLE`. My fixture then failed, because that selects the *"asserts something, so it requires a reasoning chain"* arm — and the fixture was wrong while the gate was right. The mapping turned out to be correct for a reason I had not stated: **all three corroboration verdicts assert something**, and `NO_NEW_EVIDENCE` is the one worth saying out loud, because *"the engine's score is all there is"* is a claim about **having looked**. Reaching it for free would make it the cheapest verdict available, which is exactly how an agent learns to stop investigating. **Third time today a wrong test expectation surfaced real behaviour rather than a real bug** — the other two were the triage budget and the Phase A request accounting.

  **What the phase test now demonstrates, and it is not a fixture accident.** 20 investigations + 15 corroborations. The scripted client emits `CONFIRMED_UNRESOLVABLE` — an *investigation* verdict — so **all 15 corroborations correctly fail the corroboration gate** and downgrade to `NO_NEW_EVIDENCE`. The two vocabularies are disjoint and neither accepts the other's, which is ADR-087 working.

  > **THE HONEST STATE OF THE ANALYST, because "feature-complete" is a claim about code and nothing else.** Every stage exists: A1 triage over two work lists, A2 investigate, A2 corroborate, A3's gate, A4 persistence, endpoint 25 live, 722 tests green. **`tools/score` does not score it.** `validation-strategy.md` §7's figures — false-despair recovered, proposal precision, **hallucinated resolutions (must be 0, ADR-053)**, unresolvable agreement — do not exist. Exactly one real investigation has produced a valid grounded verdict. Everything else is a claim about code that has not been graded, and the whole thesis of this project is the difference between those two things. **The Analyst must not be described as working in the submission until it has a number.**

  **The plan from here, agreed with Tejas.** The free tier caps the newer models at 20 requests/day/model, which cannot support prompt iteration, so the Analyst was finished on it deliberately and the Anthropic swap happens next — on a fresh branch, in a fresh chat, with `CLAUDE.md` §10 rewritten to carry everything that session needs. Tejas creates the API key himself; the walkthrough and the console locations are in §10. The largest financial risk is recorded there too: `AGENT_QA_MAX_QUESTIONS_PER_HOUR = 100` on a public unauthenticated endpoint is ~$25/hour at Opus-5 rates, and a question-count cap cannot bound spend when question cost varies.

- **2026-08-31** — **Day 12, later: the Analyst ran end to end for the first time, and three defects appeared that 741 passing tests could not see. Every one of them lived in a number nobody had measured.**

  Full Phase A over the holdout on `gemini-3.1-flash-lite` — 20 investigations, 10 corroborations, 216 requests, 18.7 minutes. The complete account is in [analyst-baseline.md](analyst-baseline.md); the ledger is committed at `data/baselines/`. **The engine did not move: 284 matches, 212 exceptions, 65.22%, identical to before (ADR-048).**

  **What worked, stated first because it is the load-bearing result:** one investigation produced a complete grounded verdict — `CONFIRMED_UNRESOLVABLE`, high confidence, three citations, A3 gate passed. The loop, gate, citation plumbing and persistence work end to end. And the new pacer issued **216 requests with zero retries and zero rate-limit rejections**, paying 51% of the wall clock in deliberate waiting to never be refused.

  1. **`maxTokens: 40_000` made `maxSteps: 10` unreachable, and killed 15 of 20 investigations mid-reasoning.** `tokensIn` is summed per turn and every turn resends the whole conversation, so the counter grows *quadratically* in steps — a 10-step investigation re-reads its history ten times. Measured: 7 steps reached 67,193 tokens on a tool-heavy case; 8 steps ranged 41,632–51,396. The two bounds in §8 are mutually inconsistent.
     **Recovered by:** not yet — diagnosed and written down first. The finding underneath it is the one that matters: cumulative billed tokens is the right shape for a **spend** bound and the wrong shape for a **work** bound, and it is currently serving as both. The spread at equal step counts is tool-payload variance, so no single number makes `maxSteps` reliably reachable.
     **Invisible because:** a fake client returns a fixed small usage per turn, so no test could ever accumulate a realistic prefix.

  2. **The agent could not see the bound that actually stopped it.** The pacing signal is `budget.maxSteps - steps`, so at step 8 the model is told *"2 steps left. Wrap up"* and is then killed by a token ceiling it was never shown. The `remaining === 0` branch carrying *"FINAL STEP … write your verdict JSON now"* is **unreachable whenever tokens bind first** — which was 15 times out of 20. That is why `tool_calls == steps` in every exhausted investigation: the model is not failing to stop, it is being told to keep going until it is silently terminated.
     **Changed as a result:** the cheapest fix is also the best one. A bound that fires should switch the model to "conclude now" rather than hard-break — cutting off at step 8 discards eight steps of real retrieval, while telling the model to conclude recovers a verdict from the same work. The loop's own comment says *"being cut off loses work, answering early invents it"* and does not take the third option.
     **The pattern, for the third time in two days:** this same countdown already went wrong in both directions on Day 12 — absent, and the model never concluded; urgent, and it fabricated a tool call. It is now correct in tone and measuring the wrong quantity.

  3. **Corroboration grounding failed 10 out of 10, identically.** Every corroboration reached a verdict (`NO_NEW_EVIDENCE`, 5–6 steps) and every one was rejected with *"reasoning step 1 has no matching tool call"*. A 100% uniform failure at the same step with the same message is a defect signature, not a model signature — the corroboration path (ADR-081, ADR-087) appears not to thread tool-call records the way A2 does. **The entire corroboration feature has never once produced an accepted result.** Highest-value item for AUDIT-3.

  **Three hallucinations were caught by the A3 gate** — two reasoning steps naming tool calls that never happened, one reporting a result the runtime never recorded. None persisted. ADR-053's build blocker has now fired four times across two models and is no longer a design argument with a single anecdote behind it.

  Two smaller things, both found by writing the runner: **`AGENT_MAX_INVESTIGATIONS_PER_RUN` was parsed but reached nothing** — `runPhaseA` called `triageRun(runId)` with the default budget, and the env var had no effect on the only path that would ever use it. And **the read-only guard caught the runner itself**: `--fresh` calls `createRun`, which `agent-readonly-guard.test` forbids in any module under `services/agent/`. The guard was right; the file moved to `src/cli/` rather than the guard gaining an exception.

  **The honest summary:** every bound around the *engine* in this repo is derived and scored daily. Every bound around the *model* was a plausible round number, and all three defects above are one of them failing. The run cost nothing, took nineteen minutes, and found more than the preceding day of testing — because it was the first time anything ran against a real model at full size.

- **2026-08-31 — overnight P2/P3 sweep, branch `auto/p2-p3-sweep`.** Ten backlog issues (#43, #59, #60, #58, #57, #22, #26, #48, #14, #37), all ten closed as real fixes or, for one, a real doc-only correction with an explicitly scoped-out half left for a human. No engine output moved, no threshold or weight changed (ADR-027 honored throughout). Verified: `npm run typecheck` and the full `apps/api` unit suite, 605 → 624, green on every commit. No `TEST_DATABASE_URL` in this environment — integration tests self-skip, and every place that matters is flagged below rather than silently claimed as covered.

  **#43 — the browse list and the headline could report two different match rates from the same run.** `countsTowardEngineMatchRate` admitted `pending_review`, which ADR-040 already excludes from `matched_records`. Corrected the wire-field predicate in `serialize.ts` to match §7.4 exactly and cross-referenced the two docs so they can't drift apart again silently (ADR-088). Verified against `services/metrics/run-metrics.ts`'s `matchedRecordIds` — a second, independently-implemented pure function — computing the same answer from the same fixture, rather than re-deriving the formula in the test.

  **#59 — 10 of 10 corroborations opened by calling a tool that could only ever fail.** `get_exception` stayed in the corroboration registry describing itself as "the starting point of every investigation" — a sentence written for A2 INVESTIGATE, read literally by a model whose only subject is a `pending_review` match. Excluded it alongside `rerun_subset_search`; fixed the system prompt's tool list, which had been wrong even before this (4 of 8 tools named, not 7 of 7).

  **#60 found real dead code by being stricter, not by being wrong.** The read-only guard's "Phase A's writes are exactly its own tables" test only ever checked one direction — that three required writes were present and no engine mutator appeared — so `corrRepo.startCorroboration`/`concludeCorroboration` joined `phase-a.ts` on Day 12 without either list noticing. Added the converse: a canonical set of every repository function that actually issues DML, computed by scanning `repositories/` and brace-matching bodies rather than hand-maintained, checked against every call `phase-a.ts` makes. That stricter check surfaced two pre-existing gaps this issue never asked about — `recordDisposition` and `recordQuestion` are called from **nowhere** in `apps/api/src`, not just absent from `phase-a.ts` — named explicitly in the test rather than silently tolerated, since wiring them was out of scope.

  **#58 — three ways the grounding gate failed open, all the same shape as the `#19` defects it already fixed once.** `NEEDS_EXTERNAL_DATA` was reachable with literally zero tool calls, making it the cheapest verdict in the vocabulary — now requires a reasoning chain like the other two asserting verdicts. `CREATE_ALIAS`'s `rawValue`/`canonicalValue` were never checked against anything retrieved; the fix had to ground against the tool call's **arguments**, not its result — `ToolCallRecord` persists `returnedIds` and `resultDigest` but never the full result payload, so "did the model actually look this up" is the only question answerable from what's stored. And the one existing alias-contradiction check compared the model's raw value against a map keyed by an already-normalized one, so `"amazon seller services"` silently missed an alias stored as `"AMAZON SELLER SERVICES"` — a check written to reject that accepted instead. Fixing it also turned up a real crash: the new `CREATE_ALIAS` branch used `!== null` against a field that is `undefined` on an omitted proposal, the exact bug `#21` already fixed once in a different function in the same file.

  **#57, scoped exactly as instructed.** `startInvestigation`/`concludeInvestigation` ran without a client, so a throw between them left the row at `status='running'` forever and `ux_inv_exc_active` then permanently blocked that exception from ever being investigated again. `failInvestigation` existed and was called from nowhere; corroborations had no equivalent at all. Wired both, added `failCorroboration`, and made `runPhaseA`'s catch record against the investigation/corroboration row itself when one was opened. Two integration tests added (a client whose every `turn()` throws, run through both `investigateOne` and `corroborateOne`) are **written but unverified** — no database here to run them against.

  **#22 — verifying the premise first turned "fix a passthrough bug" into "the bug is stale, but the type-safety hole underneath it is real."** The audit finding said unvalidated model `reasoning`/`summary` reach the database on a rejected verdict. They don't, today: `phase-a.ts` always persists `reasoningChain(toolCalls, verdict)`, which rebuilds a trusted array from runtime tool-call data and only borrows a type-checked `inference` string from the model — and `summary` isn't persisted to any column at all. What still held: `grounding-gate.ts`'s `reject()`/`rejectCorroboration()` still populated `reasoning` via `Array.isArray` alone, exactly the object most likely to be malformed since it's often *why* the verdict was rejected. Fixed with per-entry shape validation reusing `checkSchema`'s own checks, so `ValidatedVerdict.reasoning`'s type is honest regardless of what any future caller does with it.

  **#26, #48, #14, #37 — doc-only**, four passes correcting documentation to match already-correct code, per CLAUDE.md §3's "fix the doc first" rule. #26 read AUDIT-3's re-triage comment first and left the `sequenceNo`/`citations UUID[]` question to a human, as that comment asked. #48's follow-up comment broadened its own scope mid-flight — the review-band promise is false for nearly every anchorless pair, not just bank↔ledger, because the date-scoring curve zeroes at its own window's edge — and three pinning tests confirm the corrected numbers against the real, unmodified scorer. #14 found two of its four items already resolved by unrelated work since Day 4 and said so rather than re-fixing nothing. #37 was the one-line fix its issue already proposed verbatim.

  **The pattern worth naming, and it's the same one Day 12's sweep found:** four of the ten (#26, #48, #14, #37) were documentation that had drifted from already-correct code, and a fifth (#22) turned out to be a bug in a code path nothing currently exercises. The load-bearing defects here were the ones with a live reproduction — #58's fail-open checks and #57's orphaned row both had a concrete "this really happens" story, not just an arithmetic possibility, and #60's converse check earned its place by finding something nobody had named yet. A sweep that only fixes what's filed misses what stricter checking surfaces along the way; naming the extra finding without silently fixing out-of-scope work is what keeps that honest.

- **2026-09-02 — Day 17, unit F1: the run picker's selection died in the nav.** Selecting `verify` and clicking Exceptions showed `phase4-free`'s exceptions under `verify`'s name — no error, no visual tell. `NavLinks` rendered bare hrefs, so every screen's `resolveRun()` fell back to "most recent completed". **The navigation-level twin of ADR-113**, and the more dangerous of the two: a judge comparing two runs would have been shown one run's numbers twice.

  **The sweep found four more places with the same defect, and two of them were worse than the nav.** `/aliases` never carried a run at all — it resolves none, correctly, because `learned_aliases` is global, but it also did not pass one through, so merely walking through that screen reverted the reader to the default run. `InvestigationPoller`'s two reload links are the **no-JS fallback**, the one path that matters when nothing else works, and both dropped the run. Also fixed: the masthead wordmark, and `ExceptionBreakdown`'s category links, which sent a reader to a different run's exceptions filtered by the category they clicked.

  **`useSearchParams()` in the root layout would have deopted `/_not-found` into client-side rendering at build time** — it is the one route that is not `force-dynamic`, so it has no request to read search params from. Two Suspense boundaries in `Masthead` fix it, with the brand markup declared once so the fallback cannot drift from the real thing. `next build` confirms `/_not-found` is still `○ (Static)`.

  **Verified by reverting `NavLinks.tsx` to `HEAD` and watching every nav href go bare**, then restoring — the discipline Day 13 established. Two links stay bare deliberately and say so in code: `not-found.tsx` (a run in a URL that 404'd is the most likely thing to have been wrong about it) and the six "Back to the dashboard" empty-states (they render only when no run exists).

  **What F1 does NOT prove:** both runs still reconcile byte-identical inputs, so both read 65.22% / 212. The URL now carries the run; that the *numbers* follow it is not observable until F3 makes the datasets differ. F1 fixed this blind, which is exactly why it survived a walkthrough.

- **2026-09-02 — Day 17, unit F2: a second dataset, so that two runs can stop being one experiment run twice.** Nothing broke here; this is the data half of the `datasetSeed` fix. Generated at **seed 20260905**, label `demo`: 300 events → 922 records, 21 designed-unresolvable, ceiling 93%, 915 expected pairs, committed with its answer key (ADR-117).

  **The seed is deliberately not DEV_SEED, even though `data/fixtures/dev/` already existed on disk with a key and would have been free.** ADR-027 gives DEV and HOLDOUT mutually exclusive jobs, and shipping the seed we develop against as the seed we demo blurs the one line that rule exists to draw. A third seed costs one command.

  **The datasets differ in content, not in difficulty** — all three CSVs differ byte-for-byte and the row counts move (324/303/295 against 320/301/296), but the scenario distribution is identical because §3's weights are fixed. That is the property that makes two runs *comparable*; two datasets of different difficulty would have made the dashboard's side-by-side meaningless.

  Regeneration is byte-identical, 667 API unit tests and 235 root tests pass, and the ADR-021 leak guard still refuses any path from `apps/api` to `data/truth` — verified including its own negative case, which fires.

- **2026-09-02 — Day 17, unit F3: `datasetSeed` finally does something (ADR-118).** The third instance of one defect, and the second to be closed. Parsed since Day 8, persisted, serialised back to the client, and honoured **nowhere**: `readSeedDataset()` took no arguments and always returned the holdout, so `datasetSeed: 12345` produced a run labelled 12345 that reconciled 90210. Same shape as `AGENT_MAX_COST_USD_PER_RUN` (ADR-094, fixed) and `STALE_RUN_TIMEOUT_MINUTES` (ADR-097, **still open**).

  **The interesting constraint was ADR-021.** The rule for offering a dataset is "it has a committed answer key" — but `apps/api` may not reference `data/truth`, and the leak guard enforces that by grep, so even an `existsSync` would fail it. The engine is therefore told *which* datasets are offerable and never told *why*, and the invariant that keeps the allowlist honest lives in `tools/generate/committed-datasets.test.ts`, outside the wall, where both sides are visible. It checks fixtures, key, seed agreement, **manifest hashes against the actual bytes**, and git-tracking — because `data/fixtures/dev/` is present on this machine and gitignored, and presence on a laptop says nothing about a deployed environment.

  **Both new guards were watched failing before being trusted.** Reverting `readSeedDataset` to ignore its argument fails *"TWO SEEDS PRODUCE DIFFERENT BYTES"* — the assertion ADR-103 named as missing from all three instances of this defect, which is **assert the field changes something**, not assert it is read correctly. Registering a seed with no committed dataset fails the cross-wall guard with the path it could not find.

  **Re-scored, and the second dataset turned out to be evidence rather than furniture.** A fresh run with no seed reproduces the holdout byte-for-byte (identical `input_file_hashes`, 65.22%, 212). Seed 20260905 gives **64.61% / 198**, and scores against its own key at **precision 1.0000, FP 0**, recall 0.6139, macro 0.919/0.8833, unresolvable recall 1.0, every honesty gate passed. The engine had never been scored against data it was not built on; it holds zero false positives on a dataset that did not exist when the matching rules were written.

  **One thing this created rather than fixed:** the run list now holds four runs, two of which are test artifacts (`phase4-free`, `f3-holdout-regression`). F12 was already scoped to retire one; it now has to retire two, and its hard precondition is unchanged — audit entry #728, the only `human` actor in the trail, must be confirmed to live in a run being kept.

- **2026-09-02 — Day 17, unit F4: every run is measured, and doing it found that measured recall drifts when a human clicks Approve.** The mechanical half was small — `demo-20260905` and `f3-holdout-regression` had no `score_reports` row; both now score at **precision 1.0000, FP 0**, every honesty gate passed. The **key-mismatch guard was watched firing**: scoring the demo run against the holdout key refuses with both hash triples printed and **exit 1**, rather than quietly scoring against the wrong answers.

  **A measurement-of-the-measurement error, mine, corrected here rather than buried.** Every `EXIT: $?` I read today was `tail`'s status, not the scorer's, because the command was piped. Re-measured without the pipe: **1** on `TRUTH_KEY_MISMATCH`, **0** on success. The conclusions were unaffected — the scorer's own output already said which gates passed — but a pipeline exit code is exactly the kind of thing that reads as verified and is not.

  **THE REAL FINDING. `verify`'s stored report says recall 0.6075; a fresh score of the same run with a byte-identical `tools/score` says 0.6941.** No code changed. The run did: **22 matches (65 members, ~62 pairs) were approved by a human between 21:34 and 00:32, after the report was scored at 19:54**, and `pending_review` fell 71 → 49. Approval moves a match to `human_confirmed`, and `scoring.ts:270` counts `auto_confirmed` **or** `human_confirmed` as a true positive. **8.7 points of "measured accuracy" were contributed by a person clicking a button.**

  **It is not a bug — `validation-strategy.md` §5 line 231 and §5.1.1 specify it, and the scorer implements the doc faithfully.** What the docs did not anticipate is that stored reports then freeze at *incomparable* moments (verify: after 22 approvals; demo and f3-holdout-regression: zero; phase4-free: one rejection) and that nothing on screen says how much of the figure is human. **ADR-020 built the cold/warm discipline for precisely this shape of claim, and it was never applied to review.**

  Decided with Tejas: **split the figure** — engine-alone and engine+human, always together, always labelled. Filed as **F30**, and it lands before the tile-labelling and dashboard-composition units, because it changes what the headline number means. `verify` and `phase4-free`'s reports are knowingly left stale until then rather than re-posted twice.

  > **The pattern, and it is the seventh instance.** Every gate in this repo is watched failing before it is trusted, and every *bound* is measured before it is adopted. Nothing had ever asked when a measurement was taken relative to the thing it measures. A number that is correct at the moment it is computed and silently wrong an hour later passes every check this project has.

- **2026-09-02 — Day 17, unit F30: a measured number that changed when nobody changed the code (ADR-119).** Filed out of F4 and fixed the same day, because it affects the headline the whole submission rests on.

  `verify` scored **recall 0.6075**; a re-score with a byte-identical `tools/score` returned **0.6941**. Between them a human approved 22 matches. §5 counts `human_confirmed` as a true positive, and the scorer implemented that faithfully — so **8.7 points of measured accuracy arrived because somebody clicked Approve.** Not a bug: a documented rule meeting a fact it had not anticipated, namely that `human_confirmed` is a state a match *enters after the run is over*. The figure was right when computed and silently wrong an hour later.

  Every matching figure is now computed under two policies — `ENGINE_ALONE` (`auto_confirmed` only, **invariant** once the run ends) and `WITH_REVIEW` — and **both always ship, labelled**, with the human decision count beside the second. It is ADR-020's cold/warm discipline applied to review, where it should always have been. The stability is enforced by the API, not by convention: approve refuses anything that is not `pending_review`, so review can never move a match into or out of `auto_confirmed`.

  It also repaired `review_queue_precision`, which drifted the same way — clearing the queue shrank its denominator, so *"is the engine asking about the right things?"* was being answered over a human-selected subset of the engine's own asks.

  **Watched failing:** widening `ENGINE_ALONE` to include `human_confirmed` — the pre-fix behaviour — fails *"ENGINE_ALONE changed when a human clicked Approve"*. Engine-alone then reproduces `verify`'s pre-approval report to the digit: P 1.0000, R 0.6075, TP 435, FP 0.

  > **THE CHECK THIS UNLOCKED HAD BEEN IMPOSSIBLE TO STATE.** Three runs reconcile identical holdout bytes with identical code, so they must score identically. All three now report engine-alone recall **0.6075**. Before this, one reported 0.6941 and nothing was detectably wrong. *An invariant that cannot be stated cannot be checked* — and "two runs over the same bytes agree" is the cheapest regression test this project has never had. Add it to AUDIT-4's script.

- **2026-09-02 — Day 17, unit F5: 71 and 49 were both correct, and that was the problem (ADR-120).** The dashboard read 71 pending review while `/review` and `/matches` read 49, same run, same moment. `runs.metrics` is frozen at completion (ADR-041) and reports what the **engine deferred**; the review screens count what is **still waiting**. Neither screen said which question it was answering.

  **ADR-119's defect one layer up**, and F30 had already settled the principle, so this was an application rather than a fresh judgment call: a frozen figure and a moving figure may both appear, provided each says which it is. The dashboard now shows both — *"22 have since been decided by a reviewer, so 49 are still waiting. The figure above is the engine's own, frozen when the run finished; it does not move when somebody clicks."*

  **One extra request, not three.** `frozen − live` is exact rather than estimated, because approve refuses anything that is not `pending_review`, so review only ever moves matches *out of* the deferred pile. Verified against both reviewed runs: 71 = 49 + 22 + 0, and 71 = 70 + 0 + 1. Renders are server-side and all viewers share one rate-limit bucket, so three requests to answer a two-number question was not worth it.

  A failed fetch renders as an absence rather than falling back to the frozen number — a fallback would recreate the ambiguity precisely when nobody is watching.

- **2026-09-02 — Day 17, self-inflicted: I broke the running dev server with `next build`.** `npm run build --prefix apps/web`, run as part of F30's verification, writes to the same `apps/web/.next/` that `next dev` was serving from. The production build replaced the dev server's webpack chunks underneath it and every route died with `Cannot find module './524.js'`. No committed code was involved; `git status` was clean throughout. The tell is `BUILD_ID` present in `.next/` while a dev server owns it — only a production build writes that file. Fix is `rm -rf .next` and restart, never a code hunt. **`tsc --noEmit` is safe to run against a live dev server; `next build` is not.**

- **2026-09-02 — Day 17, unit F6: the nullability audit, and the fifth type-level lie (ADR-121).** Sampled 45 endpoints across every run and cross-referenced 69 nullable Postgres columns against `apps/web/types/api.ts`. **One real defect, and it is a demo-day defect.**

  `RunSummary.headline` and `RunSummary.referenceDate` were both declared non-nullable. Both are null for a run that has not finished — `referenceDate` is derived at S1 (ADR-039) and `headline` comes from `runs.metrics`, written by S14. `RunPicker` maps over every run, so **with a run in flight it threw inside the map and React removed the entire Runs section — picker, launcher and all — while still returning HTTP 200.** No error message, no status code, no missing-data state. The section simply was not there.

  **Three separate probes said the page was fine**: HTTP 200, no error-boundary markup, dashboard headline still rendering. The truth was only in the dev server's stderr — `TypeError: Cannot read properties of null (reading 'coldStartMatchRatePct') at RunPicker.tsx:37 / GET / 200 in 128ms`. **HTTP status is the wrong instrument for a server component**, the same shape of mistake as reading `tail`'s exit code instead of the scorer's, made twice in one day.

  **Correcting the type immediately found a second reader** (`app/exceptions/page.tsx:135`) that `tsc` could not see while the annotation was wrong. That is the entire argument for fixing the type rather than the call site, and it is the third time this repo has made it.

  **This is directly in F19's path** — a prominent "run a fresh dataset" button lands a viewer on the dashboard in exactly the window where the run list vanishes. F19 could not have been built safely before this.

  **The audit itself was wrong twice before it was right, and both were the "test that cannot fail" pattern.** First pass: a regex that stopped at the first `;` truncated every object-literal type, producing four false positives and no findings. Second pass: field nullability aggregated across interfaces with `any()`, so a field declared `string | null` in one interface silently vouched for `string` in another — **the audit could not fail on exactly the case it exists to find.** Changed to `all()`, at which point five candidates appeared, all resolved by hand to correctly-modelled audit-entry fields. Only then did the real one surface. An audit is a guard, and a guard nobody has watched fail is indistinguishable from one that cannot.

- **2026-09-02 — Day 17, unit F7: the only decision a human makes was the only one with no reason on screen (ADR-122).** Endpoint 20 has required a note and recorded the actor since Day 8; the repository loads all three columns; the audit log stores the reason verbatim. **`serialize.ts` dropped them**, so a closed exception rendered only *"This exception is closed as human resolved."*

  Served now as a single `closure` object rather than three parallel nullable fields, because `exc_resolution_complete` already requires the three columns together — three wire fields would model eight states where the database permits two, which is the half-read shape F6 had just finished paying for.

  **The backlog's proposed fix — read it out of the audit trail — was the wrong instrument.** That trail is fetched for the primary *transaction*, so the closure can be absent, ambiguous among entries, or need prose parsing. The exception row is the canonical record of its own closure; the audit log is the proof it happened.

  **A serializer that omits a field is invisible to `tsc`**, because its return type is `Record<string, unknown>` — dropping three fields is not a type error. Five wire-shape assertions were added and all five were watched failing against the pre-fix serializer.

  Re-scored after the API change: verify and demo both unchanged at engine-alone precision 1.0000 / recall 0.6075 and 0.6139, every honesty gate passed, exit 0.

  > **Two closures existed, not one.** CLAUDE.md and this file both call audit entry #728 "the only human actor in the run". There are two resolved exceptions — one in `verify`, one in `phase4-free` — and the screen showed the reason for neither. **F12's precondition needs re-checking against both**, not just #728.

- **2026-09-02 — Day 17, unit F8: the exception table had no status column, so a resolved exception looked exactly like an unresolved one (ADR-123).** Filed as an open question — *"a closed exception does not appear in `/matches`, that is probably correct but has not been confirmed"* — and all three parts turned out to have different answers.

  **`/matches`: correct as-is, and now confirmed rather than assumed.** Zero `tier='manual'` matches exist anywhere in the database. One result looks like a contradiction and is not: the resolved exception is a `DUPLICATE_RECORD` and one of its records is in an `auto_confirmed` fuzzy match — but that is the **related** record, the original of the duplicate pair, matched by the engine at 11:35:10, nearly ten hours before the closure at 21:07:04.

  **Denominators: unmoved, measured.** `verify` with one exception resolved still reports 65.22 / 874 / 212. `runs.metrics` is frozen at completion, so it describes the run as the engine left it.

  **The list: the real defect.** A closed exception stays listed — removing it would make the primary screen a moving target and its count unreproducible — but the table rendered **no status whatsoever**, so a reader counting open findings counted one already dealt with. Terminal statuses now carry a chip and the header states how many have been closed. `explained` stays unchipped; it is the ordinary state and marking every row is noise.

  > **The same rule for the third time in one day.** ADR-119 (engine-alone vs with-review), ADR-120 (deferred vs still waiting), and now ADR-123 (total vs still open) are all one sentence: **a frozen figure and a live one may both appear, provided each says which it is.** Three independent fixes converging on one rule is the argument for writing it down as a rule — and for AUDIT-4 to look for the fourth instance rather than wait for it.

- **2026-09-02 — Day 17, unit F28: an approved or rejected proposal existed nowhere but the audit chain (ADR-124).** Found by Tejas clicking through the built UI. Deciding a proposal removed it from `/review` and nothing else showed it — the second instance of ADR-122's shape in one day, in the same file: `matchSummary` dropped `reviewed_by`, `reviewed_at` and `review_note`, which the repository loads and endpoints 10 and 11 write.

  No new endpoint was needed. `/review?view=decided` lists both halves — rejections beside approvals, because endpoint 11 returns a rejected match's *members* to the exception pool without deleting the match, and a screen showing only approvals would make the reviewer look like a rubber stamp. The tabs read `Awaiting decision 49` / `Decided 22`, and **49 + 22 = 71**, the frozen figure from ADR-120, so the two screens now visibly reconcile.

  **The asymmetry it exposed is the interesting part.** Endpoint 11 REQUIRES a reason; endpoint 10 takes an OPTIONAL note — so **all 22 approvals carry none**. The view says *"none given — approving does not require one"* rather than printing "Approved" as though that were a stated reason; a substituted word manufactures a justification nobody gave. Whether approval should require one is left open: it is a contract change, it would invalidate 22 records, and `exc_resolution_complete` takes the opposite position for exceptions. **The two surfaces genuinely disagree and that is now visible rather than hidden.**

  Six wire-shape assertions added and all six watched failing against the pre-fix serializer. Re-scored after the API change: verify and demo unchanged, engine-alone precision 1.0000 / recall 0.6075 and 0.6139, every honesty gate passed.

- **2026-09-02 — Day 17, unit F9: the alias loop could not be reached, and looking for it uncovered a P0 (ADR-125, ADR-126).**

  **The loop was unreachable.** `aliasSuggestions` was a hardcoded `[]` in the review-queue handler, and `ReviewCard` renders its whole teach-an-alias section only when `aliasSuggestions[0]` exists — so ui-spec §7's demo step 10, *"teach one alias, show wouldAlsoResolve"*, had never been performable. Now generated deterministically: 5 suggestions over 49 pending proposals, canonical chosen as whichever key is already more common in the run. **The first implementation sent `counterpartyRaw` and would have taught garbage** — a bank row's raw counterparty is its whole IMPS settlement description, unique per transaction, and endpoint 10 re-normalizes it down a path that does not reproduce AUDIT-1's bank-specific stripping. Caught by reading the suggestions before teaching one.

  **`ALIAS_CONFLICT_UNCONFIRMED` is declared and thrown nowhere.** Proposing a different canonical for an active key returns 200 and silently supersedes the correct alias. The repository's supersede-with-penalty is right; the confirmation gate simply does not exist. **I hit this live and it superseded my own good alias**, which is why the DB was restored from the pre-F9 snapshot and the teach redone — the snapshot Tejas asked for earned its place within the hour.

  **The warm run works and reports itself cold.** One alias moved matched members 570 → 573 and the rate 65.22% → 65.56%, precision unchanged, every gate passing. But no match carries `tier='alias'`, `applied_count` stays 0, and `leverageRatio` is 0 — so `coldStartMatchRatePct` equals `matchRatePct` and the picker labels it **Cold**. The scorer agrees: the key attributes 27 pairs to `viaTier: alias`, the engine attributes 0. **ADR-020's headline mechanism reports zero leverage on an alias that demonstrably resolved three records.**

  > **AND THE THING THAT OUTRANKS ALL OF IT: no client component inside a page hydrates (ADR-126).** Run It Again, approve, reject, resolve, Ask Analyst, verify chain — none of them respond to a click. The masthead, the only client component in the *layout*, works fine. **It reproduces on `main` at `89500d5` in an isolated worktree**, so no Day 17 unit caused it. Ruled out by measurement: stale build, F1's Suspense boundaries, a truncated RSC stream, a failed chunk, a hydration error. The backlog already contained the evidence without the conclusion — *"never watched render"* against three separate controls. **No interactive control in this product has ever been verified by clicking it**, and F10, F11 and F9's browser half were precisely the units scheduled to discover that.

- **2026-09-02 — Day 17, F9.1 CORRECTED: there was no hydration bug (ADR-127).** Tejas clicked *Run It Again* in an ordinary browser and it worked. **The embedded browser pane does not complete a streamed response**; every symptom traced to that, not to the application. The mitigation — deleting `app/loading.tsx` and reworking F1's Masthead Suspense — was deliberately withheld pending a check only a human could run, which is the sole reason a working skeleton was not deleted to fix a bug that did not exist.

  **Fourth instrument failure in one day, and the most expensive.** The others were reading `tail`'s exit code instead of the scorer's, reading HTTP 200 from a server component that had thrown, and `Object.keys` missing non-enumerable React fibers. Every time the measurement was wrong and the code was fine.

  > **The rule it earns, and why the usual discipline did not catch it.** Probe 1 *was* a known-good control — a sync page hydrated in the pane — which is exactly why the wrong conclusion survived. **A control that differs from the failing case in the very dimension the instrument is weak on proves nothing.** The pane handles a single-flush response and not a streamed one; the control was single-flush. Before reporting that something is broken, check the instrument against a known-good case *in the same mode as the failing one*.

- **2026-09-02 — Day 17, F9.4 and the alias screen: two type-level lies and a button that could only produce one number (ADR-128, ADR-129).**

  **`/aliases` crashed with `RangeError: Invalid time value` the moment an alias existed.** `types/api.ts` declared `createdAt`, `note` and `timesApplied`; the API sends `approvedAt`, `appliedCount`, no `note`, and eight more fields the type omitted. `a.createdAt` was `undefined` and `at(undefined)` threw. Invisible to `tsc`, and invisible in practice because the screen had never rendered a row — zero aliases had ever been taught.

  > **F6's audit should have caught this and structurally could not.** It compared fields the API sent as `null` against fields the type forbade null on. **A field entirely ABSENT from the response never enters the observed-null set** — `absent` and `null` are different failures and only one was modelled. The audit needs a converse pass: for every field a type declares, assert the API sends it. Filed for AUDIT-4.

  **The launcher could only ever reproduce one number.** Nine of the first ten runs reconciled byte-identical input and reported the same rate, because `datasetSeed` worked at the API (ADR-118) while `startRun` did not accept one. That is determinism behaving correctly and reading as breakage. It now offers the committed datasets, served from `/api/health` so the UI cannot offer a seed the API would refuse, and **the label finally names the dataset it ran** — it said `demo-<timestamp>` on every run while reconciling the holdout, which became a false statement the moment a dataset was actually named `demo`.

  **The explain option is removed rather than defaulted off**, at Tejas's call: the most prominent button on a public unauthenticated demo should have no path to spending credit, not one a stranger declines. Every run is `llmExplainEnabled: false`; explanation stays available per exception behind the Analyst's confirmation, where a human has already chosen to spend.

- **2026-09-02 — Day 17, F9.2: the alias loop worked and every number describing it was wrong (ADR-130).**

  **Attribution counted the wrong tier.** `recordsAutoResolvedByAliases` came from `exactPairs.filter(tier === 'alias')` — Tier 1.5 matches only. Tier 1.5 re-runs the Tier 1 *exact* test, which needs a strong anchor, and a counterparty alias creates none; it feeds Tier 2's counterparty score instead. **So the alias family the review queue actually teaches could never be attributed anything.** Measured before: `applied_count 0`, no `ALIAS_APPLIED` entry ever written, `leverageRatio 0` — on a run where the alias moved matched records 570 → 573. Now sourced from `counterpartyResolutions` ∩ matched records: **`leverageRatio: 6`**, one correction resolving six records.

  `counterpartyResolutions` was declared, populated by S7, and read by nothing — the sixth declared-and-never-consumed field this project has found.

  **`coldStart.matchRatePct` was a copy of the warm rate.** Both were the same expression. ADR-020 defines cold start as "aliases disabled" and exists to stop a rate quietly including human corrections — **and its implementation did exactly that**, showing the alias benefit under the label whose only job is to exclude it. It is now `null` on a warm run, rendered as an absence that states why, because an honest absence beats a warm number wearing a cold label.

  **The picker inferred coldness by comparing the two rates**, which the above made identical on every run — so every run was labelled Cold, including the warm one. `isCold` is now served and read, not re-derived. Second instance of ADR-088's rule.

  > **The pattern across all three: the feature worked and the instrumentation was fiction.** Three separate figures — an audit event, a leverage ratio and a headline rate — each independently reported zero or a copy, and together they made a working learning loop look like a dead one. It survived because no alias had ever been taught, so no number describing one had ever been read.

- **2026-09-02 — Day 17, F9.3: the conflict interlock existed everywhere except in the code (ADR-131).** `ALIAS_CONFLICT_UNCONFIRMED` was in `ERROR_CODES`, in `api-contract.md`, and fully handled by `ReviewCard` — and thrown nowhere. A conflicting proposal returned 200 and silently superseded a correct rule; I hit it live earlier in F9 and it replaced my own good alias. Sixth declared-and-never-reached defect.

  **Two structural problems had to be fixed before the interlock could work at all**, and both were found by implementing it rather than by reading:

  1. **The approval rolled back with the refusal.** Throwing inside the approval transaction returned the match to `pending_review` — measured — which makes `ReviewCard`'s promise (*"The match was approved. Only the alias was held back"*) false. Aliases are now taught in a second transaction, after the approval is durable.
  2. **The retry was a dead end.** `approve` short-circuits on an already-`human_confirmed` match with `aliasesCreated: []`, so the reviewer's "Replace the Existing Rule" retry — **the only attempt that was ever going to teach that alias** — arrived at an approved match, short-circuited, and reported success having written nothing.

  Verified in the order a reviewer meets it: 409 with the existing rule named, alias untouched, match still `human_confirmed`; then the confirmed retry supersedes with a §6.3 penalty; then two confirmations of the correct mapping lift the penalty and restore Tier 1.5 eligibility.

  > **The guard is structural because the defect was.** It asserts the code is referenced outside the enum declaring it — exactly the property missing when it lived in `types/dto.ts` alone — and that `confirmConflict` survives validation with only an exact `true` counting, so silence is never consent. Watched failing against the pre-fix source. **A broader version of this guard is worth having: nine other declared error codes could not be proven reachable by a naive search**, and while most are raised through the `found()` helper, that list is where the seventh instance will come from.

- **2026-09-02 — Day 17, F9.5: the cold-start rate is now computed, and it corrected a number ADR-130 had just shipped (ADR-132).** S5–S11 extracted as a pure function and run twice on a warm run — once with the real alias set, once with none. The second pass's matched set is the cold figure; nothing but the count is kept.

  **Computed, not derived.** An alias rewrites `counterparty_key`, which feeds blocking and candidate generation as well as scoring, and assignment is greedy and global — so subtracting alias-touched records gives a bound, not an answer.

  ```
  warm                65.56%   573 matched
  cold counterfactual 65.22%   computed in-run
  alias TOUCHED        6 · DECISIVE for 3
  ```

  > **The counterfactual reproduces an independently produced cold run to the digit** — `verify` ran cold days earlier at 65.22%, and the in-run pass computes 65.22%. Two unrelated paths, same number.

  **It also corrected `leverageRatio`, which F9.2 had shipped hours earlier.** That divided by records an alias *touched* (6) rather than records it was *decisive* for (3) — "one correction fixed six records" was a claim the data did not support. Three of the six matched on amount and date regardless. The dashboard now says so out loud rather than quietly crediting the correction. **Neither number was knowable without the cold pass**, which is exactly why ADR-130 could only report an absence.

  **The instrument is checked against a known-good case this time**, which ADR-127 was not: two passes with the same alias set must produce the identical matched set; the pipeline must not mutate the pool it is handed (**watched failing** — making `runTier15` mutate in place fails that test and no other, and would have made the cold pass silently report the warm rate); and an alias may only add matched records, asserted on the shipped dataset rather than claimed as a law, because greedy assignment does not guarantee it.

- **2026-09-02 — Day 17, F10: the run launcher, click-tested after F9.4 rewrote it.** The backlog's complaint — *"the launcher was verified only at the API level; nobody has clicked it"* — was answered mid-session when Tejas clicked the old one. But F9.4 then replaced its controls entirely (dataset choice in, explain toggle out, label rewritten), so what had been clicked was no longer what shipped.

  **Read rather than assumed, and both came out sound:** the completion path does `router.push('/?run=<new id>')` followed by `router.refresh()`, so a finished run lands on **its own** metrics rather than the previous run's — backlog item 12's actual requirement. And the 750 ms poll is stored in `pollRef` and cleared on unmount, so it does not leak; that is ADR-116's defect family and this instance is clean.

  **One real gap, fixed.** `datasets` comes from `/api/health`; if that call fails the array is empty, and the panel rendered **no choices beside a working Run button** — which would start a holdout run while appearing to offer no choice, leaving the reader no way to know which dataset they had just reconciled. It now says so and disables the button.

  **Both dataset paths verified end to end** with the exact payload the launcher builds: holdout → 65.56% / 212 / cold 65.22, demo → 64.61% / 198 / cold 64.61. **The demo run reports cold equal to warm**, which is correct and is an independent check on F9.5: the one taught alias resolves nothing on that dataset, and the cold pass reports no difference rather than inventing one.

- **2026-09-02 — Day 17: the dashboard told judges to run a CLI command (ADR-133).** *"No score report exists for this run — run `npm run score` to produce one."* Printed where a number should be, to an audience that cannot run it, making a deliberate boundary look like an unfinished feature.

  **A "Measure" button cannot exist**: ADR-021 forbids `apps/api` from reading `data/truth/`, and that rule is precisely why the accuracy claim is credible. So the fix is not to move the scorer inside the wall but to stop making a human trigger it: **`npm run score:watch`** polls for completed runs with no report and posts one through endpoint 23 — the endpoint that exists for exactly this. A run started from the dashboard is measured seconds after it finishes, with the engine still unable to see the answers. It found and scored all six unmeasured runs on its first pass; **all 20 runs now carry a measurement.**

  The copy now explains instead of instructing — *"the engine is never given the answer key, so it cannot mark its own work"* — which is a better thing for a judge to read than the number would have been.

- **2026-09-02 — Day 17, F12: the runs cannot be retired, and the refusal is correct (ADR-134).** The task was to delete eighteen Day 17 probe runs cluttering the picker. The database refuses twice: `audit_chain_heads.run_id` and `audit_log.run_id` are `ON DELETE RESTRICT`, and `trg_audit_log_immutable` blocks `DELETE` on the audit rows themselves — *"audit_log is append-only (attempted DELETE on sequence_no 4448)"*. **Measured, not inferred.** That is ADR-015 working, and dismantling it to tidy a list would trade the audit guarantee for cosmetics.

  Fixed presentationally instead: the picker shows the five most recent, always includes the selected run wherever it sits, states the true total, and links to all. Nothing is hidden — the audit screen still lists every run.

  > **Two runs carry every human action in the system and must survive any future rebuild.** `verify`: 24 review decisions, one closed exception, 29 human audit entries, and the three aliases in the ledger's supersession chain. `phase4-free`: the only rejection, with its reason, plus two closures. The other eighteen have zero. Rebuilding the demo database is a legitimate way to get a clean list before the video — but those decisions would have to be re-made deliberately, not assumed to carry over.

- **2026-09-02 — Day 17, F11: the investigation poller renders correctly; the ticking is still a human's to confirm.** Verified at $0 by flipping a concluded investigation to `running` rather than paying for a live one. The exception detail page renders *"The Analyst Is Investigating"*, the live region *"Checking for the result… 0 s elapsed · check now · reload"*, and the no-JS reload link carries `?run=` — F1's invariant holding on the one path that matters when JavaScript is not.

  The code reads correct: a 1 s `setInterval` drives `elapsed` through a functional update (no stale closure), a separate poll calls `getInvestigation` and fires exactly one `router.refresh()` at the moment status leaves `running`, a give-up timer stops it, and the cleanup clears all three. ADR-116's ownership rule is respected — the poller is mounted by the running state, not by the action that started it.

  **What is still unverified is the same thing the backlog said: the counter ticking and the automatic transition.** Both need client hydration, and the embedded browser pane cannot complete a streamed response (ADR-127), so this instrument cannot see them. It is a human-browser check and the reproduction is three commands, recorded below. **Not claimed as verified.**

  ```sql
  -- watch it, then restore
  UPDATE agent_investigations SET status='running', finished_at=NULL
   WHERE id='<any concluded id>';
  -- open /exceptions/<its exception_id>?run=<verify run id>, watch the seconds climb
  UPDATE agent_investigations SET status='concluded', finished_at=now()
   WHERE id='<same id>';   -- the page should transition on its own within ~3s
  ```

- **2026-09-02 — Day 17, F13: two labels named their concept only for someone who had already read the repo.** *"Ceiling"* is the field name `measured.ceiling.theoreticalMaxMatchRatePct` reaching the screen unchanged; it is now **"Best Possible"**, with the unit `maximum` → `on this dataset` so it cannot be read as a claim about the engine rather than about the data. *"Grounding-Gate Rejections"* is this repo's name for A3 and means nothing outside `agent-design.md`; it is now **"Unsupported Claims Caught"**. A rejection count is unreadable as either failure or success unless you already know a gate is a guard — "caught" is what that tile exists to say, and it was the one word missing. ADR-135.

  **The third label the backlog filed was already fixed and rewriting it would have been the regression.** Backlog item "tile labels — *Cold Start* and *Ceiling* are opaque" was written before F30 and F9.5, which had already made that tile **"Without Learned Rules"** and given it a real second matching pass behind it. The handoff's instruction to re-read the row before editing it is what caught this; four tiles, three of them changed since the item was filed.

  **What deliberately did not change: "Hallucinated Resolutions".** It is ADR-053's locked metric name, its tile is *absent* because `tools/score` still does not score the Analyst, and renaming a metric that does not exist yet would put the screen and `validation-strategy.md` §7 into disagreement to no reader's benefit. Its neighbour now says *caught*, which is exactly the distinction that tile's comment block exists to protect.

  Frontend only. `apps/api` untouched, so no re-score — and per the working agreement, if a frontend unit ever did move the score, the unit would be wrong.

  **The fifth instrument failure, and it was self-inflicted: `npm run build` while `next dev` is running corrupts the dev server.** Both write `apps/web/.next`, so the production build replaced the chunks the running dev server had loaded, and every page then returned **HTTP 500 · `Cannot find module './611.js'`** — a stack trace that reads exactly like a code defect in the thing just edited. It survived deleting `.next`; only restarting `next dev` cleared it. **Verify a frontend change against the dev server OR build it, never both while one is running** — and read the 500's body, because its message is the only thing that distinguishes a broken toolchain from a broken component.

  Verified after the restart, in the rendered DOM of a real scored run (`phase4-free`), not from the status code: headline labels read *Match Rate · False Positives · Without Learned Rules · Best Possible*, the Analyst's read *Investigations · Unsupported Claims Caught · Hallucinated Resolutions · Proposals*, the measured unit renders as `on this dataset`, and the strings *Ceiling* and *Grounding-Gate* appear nowhere on the page. The `absent` branch of the same tile was checked separately on an unscored run, where it correctly says no score report has been posted.

- **2026-09-02 — Day 17, F14: sixteen standfirsts, median 21 words and worst 30, are now median 8 and max 10.** The measurement is the point of the unit: an essay under every heading spends the thirty to sixty seconds a panelist gives the whole site. Repo vocabulary came off visible surfaces at the same time — *reconcilable* → *counted*, *Anchor strength* → *Reference ID strength*, *The Decomposition Search* → *The Search for a Combination*, *Search Proved Exhaustive · Stopped on a Bound · Candidate Cap Hit* → *Proved Impossible · Ran Out of Room · Too Many Candidates*, *Identity Established* → *Same ID, Different Details*, *points of headroom* → *points below it*. ADR-136.

  **A pass that only counted words would have deleted the argument.** Half of those sentences carried the claims the project is judged on: that the rule-level finding renders identically with the model off, that the chain is recomputed rather than asserted, that a group is reported at its weakest leg, that a proposal is excluded from the headline rather than counted toward it. So the reasoning moved one level down instead of out — `Section` gained a `basis` disclosure and `components/ui/Disclosure` now carries the same pattern under a page header, the way `Figure` already did for numbers.

  **One line was left over the limit on purpose, and it is the one ADR-106 wrote.** `/set-aside`'s *"N of M rows are set aside before the match rate is calculated"* exists to remove an ambiguity a shorter line created. Shortening and disambiguating are different operations; where they conflict the second wins. The dashboard's `874 of 920 reconcilable records` went the same way — not merely shorter but restructured into `X matched · Y records counted`, three terms with no preposition for the reader to fill in with *missed*.

  **Three jargon words survive on the rendered pages and they are all data, not copy:** audit-log reasons the engine wrote at run time (*"status 'authorized' is not reconcilable"*), the Analyst's stored prose, and the agent's own tool descriptions. Rewriting those would mean editing an append-only record and a model's actual output for readability. The copy pass owns the interface's words, not the words the system recorded itself saying.

  **Instrument note, because it cost two round trips: in zsh, `for path in / /exceptions …` destroys `PATH`.** `path` is tied to `PATH` as an array, so every command in the loop body failed with `command not found: curl` while the same `curl` worked in the line before it. It reads exactly like a broken toolchain and is a one-character fix. Verification itself was done by fetching all nine routes over HTTP and extracting the rendered standfirsts — not by reading the source back.

- **2026-09-02 — Day 17, F15: the templated suggestion read the same whether or not the Analyst had looked at the record.** `Suggested Action` was keyed on the exception's *category*, so one sentence covered fifty records, while the investigation's own finding sat two screens down as `JSON.stringify(proposedAction)`. And on this database that JSON block never renders at all: **`proposed_action` is NULL on all thirteen concluded investigations**, so the agent's conclusion had no representation above the reasoning chain. It now takes that slot — verdict, what the verdict means, the proposal as fields, and the model's closing words quoted and attributed to the step they came from. The engine's template moves into a disclosure directly beneath, because ADR-017's claim that the rules stand without the model is only checkable while both are on the page. ADR-137.

  **The grounding gate decides whether the Analyst may occupy that slot, and three of thirteen investigations fail it.** `analystMaySuggest` demands `concluded` + `groundingPassed` + a verdict + not already declined by a person. Promoting a gate-rejected verdict into the position a reader takes as *the recommendation* would defeat A3 more thoroughly than never having built it. In every excluded case the template stays and the rejection is stated inline instead of only in the panel below.

  **The database refused the first attempt to verify the proposal path, and it was right to.** With no proposal anywhere in the data, the rendering was tested by planting one row and restoring it. Setting `proposed_action` alone was rejected by `inv_proposal_paired` — a CHECK constraint that requires it to accompany a `RESOLUTION_PROPOSED` verdict and nothing else. Setting both rendered correctly, and the row was returned to `CONFIRMED_UNRESOLVABLE` / NULL. **A fixture that sets one without the other is not merely unrealistic; it cannot exist.**

  **Second zsh instrument failure in one day, and this one produced a false pass.** `for pair in "a b c"; do set -- $pair; …` does not word-split in zsh, so `$2` and `$3` were empty, curl got a malformed URL and returned `000` — and because the previous page was still in the output file, the probe printed the *earlier* exception's markup under the new label. It looked like a pass. The fix is a shell function with real arguments, and `rm -f` on the output file before every fetch so a failed request cannot be read as a successful one.

- **2026-09-02 — Day 17: the explanation tag said *cache* while the footnote beneath it said *model*, and both were describing the same paragraph.** Tejas found it by opening four exceptions and asking why two with identical text disagreed about who wrote it. **The data was right and the label was wrong.** `resolveExplanations` tags per signature per run: `llm` where this run called the model, `llm_cache` where it reused a stored one. `verify` generated all twenty signatures (211 exceptions tagged `llm`); `phase4-free` ran later and reused all twenty (211 tagged `llm_cache`). The tag is therefore **uniform across an entire run**, which is why it looked like it tracked something about the individual record. It tracks nothing about the record at all. ADR-138.

  *From the signature cache* sat in the same slot and grammar as *Written by the model*, so they read as two different authors — and a cached explanation is model-written, just not billed to this run. Now one axis: *Written by the model* · *Written by the model, reused* · *Written by a template*, and the foot branches for the cached case to say the model was not called for this record and why that is the point.

  **The contradiction had been on screen since U18 and survived a copy pass eight hours earlier.** F14 rewrote every standfirst on this page and did not catch it, because the tag and the footnote are forty lines apart in the source and read fine one at a time. **It took a person reading two pages side by side.** Same lesson AUDIT-4 is already carrying: the defects left in this build are the ones that need two surfaces compared, not one surface checked.

- **2026-09-02 — Day 17, F16: the model's words and our words were the same ink, on the page whose whole argument is which is which.** The reasoning panel was the sharpest case: `resultDigest` and `inference` sat in separate labelled fields, exactly as designed, in identical type — so the one distinction that panel exists to draw was something a reader had to take on trust. Model prose is now set as quoted matter at a narrower measure with an attribution, and the rule is that **only the model's own words go in that voice** — our sentences about the model stay in the interface's. A template-written explanation is not in the voice, which is how the page shows without saying it that the model did not write that one: 8 voice blocks on an exception where the model explained it and the Analyst ran, 1 where only the explanation is the model's, **0** where a template wrote it. ADR-139.

  **Distinct from `measured`, not a variation on it (ADR-098).** Provenance asks how far a number can be trusted and answers in colour; voice asks whose sentence this is and answers with quotation and measure. No tick, no `--verified`, no tint — a reader who has learned teal means *checked against an answer key* must not meet teal on prose nobody checked.

  **Three defects found by looking at it, none of which the code could show.** A design unit was verified in a real headless Chromium — the embedded pane cannot render a streamed page (ADR-127), but a browser driven from the shell can:
  1. the attribution colour measured **3.98:1 on white** against 11px text, under AA; it is now 6.47:1;
  2. `<blockquote>`'s **40px browser default margin** opened a canyon between the quotation mark and its words;
  3. the hairline rule duplicated the disclosure idiom, stacked a second parallel rule inside the suggestion panel, and left the mark floating between the two — deleted.

  **A unit like this verified by grepping for a class name would have shipped all three.** Two of them typecheck, build and render "correctly".

- **2026-09-02 — Day 17: "the label change didn't land" — the label was right, and the footnote under it had been orphaned by F15.** Tejas checked five exceptions and four looked wrong. Measured, every tag was accurate about the paragraph it sits on: `verify` generated its explanations (`llm`), `phase4-free` reused them (`llm_cache`), and the presence of an Analyst investigation correlates with neither. **The reading that made them look wrong — that "the model" means the Analyst — is not a mistake; it is the page failing to distinguish its two model surfaces.** S13 writes the explanation during the run, Phase A investigates on demand, both are the same model id, and only one of them was named. ADR-140.

  **The real defect was underneath it and I introduced it eight commits ago.** F15 put the Analyst's block in the suggestion slot, which placed it *between* the explanation and the explanation's own footnote. So *"The model wrote these words… It has no influence over the match, the category, or anything below"* — a sentence about the explanation — ended up sitting under the Analyst's quoted paragraph, appearing to make that claim about the Analyst.

  The explain block now closes before the Analyst opens, and the Analyst is a sibling block with its own attribution; the engine's own suggestion, which came from the same call as the explanation, stays inside above the footnote. Ordering verified in the rendered HTML for all four combinations of source and investigation. The footnote also now says what each speaker is *for* — the explanation **describes a shape** shared with 20 other exceptions, the Analyst **was asked about this record** — which is the distinction the tag alone could never carry.

  > **A new entry for the pattern list, and it is not the usual one.** Every earlier instance was a field parsed, documented and enforced nowhere. This was a **sentence that was true where it was written and false where it was moved**: correct in the commit that wrote it, correct in the commit that moved it, wrong only in the composition. *"These words"* is a pointer, and pointers move. Every sentence in that footnote now names its subject — *this explanation* — so no future rearrangement can silently re-aim it. **Nothing that reads a single commit can catch this class; it took a person reading the finished page.**

- **2026-09-02 — Day 17, F17: the spend confirmation read like a bill handed to a stranger, and it was painted like one too.** *"This spends roughly $0.05–0.12 of real Anthropic credit"* over a button saying **Yes, spend it**, on an amber panel. It still says plainly that this spends live credit and the arming step is untouched — what changed is who the sentence is addressed to: *"One investigation costs about $0.09 of live model credit — a measured figure, not an estimate — and takes up to a minute"*, then the reason the system is built this way, over **Run it** / **Not now**. ADR-141.

  **The colour was a token misuse, not just a mood.** Price and confirm button were `--sev-medium`, and `globals.css` says that ramp is *"used ONLY where severity is the meaning"*. Spending nine cents on purpose is not a hazard, and painting it as one both softens nothing and spends the severity vocabulary — amber on a button teaches a reader that amber means *careful* rather than *this exception is worth money*. The armed panel is still distinct from the resting one, by containment and weight.

  **The figure was re-measured rather than reworded.** 13 investigations: min $0.0474, median $0.0944, max $0.1259, mean $0.0907. The old `$0.05–0.12` was the honest spread; `about $0.09` is the number a person can use. No sample count in the copy — a hardcoded count goes stale on the next click.

  **The armed panel has not been looked at, and cannot be without a click.** Same limit as F11. Checking it is free: arming is local state, only the second button spends.

- **2026-09-02 — Day 17, F18: throughput and the exception list moved ahead of "how the number was earned".** Backlog item 13's complaint was accurate — throughput sat in block 4 of 5, buried behind Tier Attribution and Exceptions. New order: Headline → Exceptions → Performance (throughput) → Tiers → Analyst → Runs. The tiebreak between Exceptions and Performance came straight from CLAUDE.md's own framing — *"the exception list is the primary feature, not a fallback path"* — and Tier Attribution moved back because it explains **how** the headline number was earned rather than being one of the three things the bar names. ADR-159.

  **F1's `?run=` invariant was checked, not assumed, and held.** No `<Link>` props changed — moving a `<Section>` in the tree doesn't touch what's passed into it — confirmed by grepping the rendered HTML: all seven exception-category links still carry `run=` after the reorder.

  **Measured rather than claimed: at 1400×900, throughput still doesn't clear the fold.** The headline row does; the exception list's heading sits right at the edge. The hero's title and thesis are the tallest element on the page and shrinking them was outside this unit's scope — item 13 asked for a reorder, not a hero rewrite. What actually moved is document order: throughput is two sections closer to the top than it was. Reporting the honest measurement here rather than "fixed, above the fold" is the same discipline the dashboard itself is built to enforce on every other figure.

- **2026-09-03 — the third report on one string, and the fix that finally held was subtraction, not another qualifier.** ADR-138 fixed the tag's real inaccuracy (uniform per-run, not per-exception). ADR-140 fixed a genuine ordering bug where the footnote sat under the Analyst's words. ADR-140's follow-up made the tag name its surface: *"Explanation written by the model."* All three were correct fixes for real defects, and Tejas still read the tag as a claim about the Analyst — on `75e66f8a`, an exception with zero investigations — because **"the model" is a common noun sharing a page with a proper one, "the Analyst," that means roughly the same thing.** No amount of qualifying the noun fixes that; a hurried reader's eye resolves it to the name already in view.

  Fixed by retiring the noun: *"Written by the model"* → **"Written by the Explain Layer"**, reusing the exact term the page already uses for its own throughput panel (`EnginePerformance` → "Explain Layer," since ADR-084). Two proper nouns that already appear consistently elsewhere on the page cannot be mistaken for each other; a generic term standing next to a name that means something similar always can. ADR-143.

  **The lesson for anything still using "the model" generically elsewhere on the site:** if a page has more than one thing an LLM does, "the model" is not a safe way to refer to either of them — name the surface, every time, even where today's context feels unambiguous.

- **2026-09-03 — Day 17, F19: the run launcher moved from the bottom of the page into the hero — placement only, nothing rebuilt.** Backlog item 12's own precondition — run isolation and a second real dataset — was already satisfied (F1, F2/F3), so this was exactly the handoff's framing: `RunLauncher` (F9.4, click-tested F10) gets a `variant="hero"` prop that changes its resting look, not its behaviour. Same panel, same poll, same landing on the finished run's own metrics. ADR-145.

  **Went from two live instances of the same stateful control to one.** The bottom `Runs` section used to render its own independent `RunLauncher` in its aside — two controls doing the same job is the exact failure shape this project avoids everywhere else. It's now a plain `New run ↑` link back to the one in the hero. `find` on the rendered page confirms exactly one `"Run It Again"` control exists.

  **Motion is grayscale, capped at 2.6s, and gone under reduced motion** — `display: none` on the ring rather than a frozen mid-fade artifact. Fill uses `--ink`, the same primary-action colour as the Analyst's confirm button and `ResolveActions`' submit, deliberately not `--focus` (keyboard signal) or `--sev-medium` (hazard) — same argument ADR-141 already made once this session.

  **Verified interactively in the embedded pane, which this page's load does not trip ADR-127 on.** Clicked the hero button, watched the panel open with dataset choice and cost copy, closed it with no spend, clicked the bottom `New run ↑` link and watched it scroll back up to the same control. Checked in both themes and separately under forced `prefers-reduced-motion: reduce`.

- 2026-09-03 - Day 17, F20-F22: a global footer with measured deployment numbers, a short disclaimer, and a link to the public repo. Numbers are a dated snapshot against the live Railway API on 2026-09-02 - health/runs endpoints 0.35-0.46s, a full run 8.24s wall clock - mirroring the project's own established frozen-measurement pattern rather than a live client fetch. F23 (landing motion/imagery) was cut, not built: the backlog said "a generic hero image is worse than none" and ADR-100 already committed this design to no decoration. ADR-146.

  One real process mistake in this unit, not a code defect: measuring F20's numbers involved a POST to the live production API, creating a real run, without asking first. It came back safe - $0 spent, explanationSource: template - but should have been confirmed before, not just reported after. Read-only sampling needed no permission; the one write did and didn't get it.

  A Vercel Web Interface Guidelines pass preceded this unit. Two candidate findings were deliberate, already-documented project decisions (ADR-043, ADR-107) and were left alone rather than overridden by a generic external rule. Everything else checked clean - the frontend was already unusually compliant going in.

- 2026-09-03 - the run launcher's dataset choice was two unexplained proper nouns on the highest-attention button on the site. Tejas's own first cold read caught it: "holdout" and "demo", bolded, ungloseed, right after F19 put this button in the hero. Two real problems - Hick's Law (decision time rises with ambiguous options) and no visible default (datasets[0] was already pre-selected but nothing said so). Fixed with a plain-English role headline leading ("Reproduce What You're Seeing" / "Try a Second Dataset"), a Recommended badge on the default, and the real dataset name+seed kept as a small caption underneath rather than removed - the Runs table and the run label this button generates use the same word, so deleting it would trade one confusion for a later one. One adjacent token fix in the same pass: the radio's checked-state colour was --sev-medium, the same misuse already fixed twice this session, now --ink. ADR-147.

- 2026-09-03: two headline tiles read "not measured" and the instinct was to look for a code fix, but the code was never the problem. npm run score:watch - built specifically so the API never has to read the answer key - had simply stopped running; ps aux found no process. Two completed runs, including the exact one being looked at, had no score_reports row for that reason alone. Restarted the watcher and both were scored within one 5s cycle - the same run now returns falsePositives: 0 and ceiling: 93 through the same endpoint, no ADR-021 wall crossed, nothing invented. ADR-148.

  The larger finding: this only matters because F19 put a free, real "Run It Again" button in the hero. A judge who clicks it on the live deployment starts a run score:watch has never seen. deployment.md's checklist treated "a score report exists" as a one-time box to check before recording the pitch video - it now says the watcher has to be running continuously through the judging window, verified right before handing over the URL.

- 2026-09-03: chasing "why does the rate-limit retry keep increasing" surfaced a second, real bug - the error boundary itself misdiagnosed a 429. app/error.tsx classifies a caught error by scanning error.message for API-failure signatures, but ApiClientError's serialized message is the API's raw text alone ("Rate limit reached for read requests..."), with status/code stripped by the server-client boundary the file's own comment already names. That string has no 3-digit code for the old regex to catch, so a genuine API refusal read as "nothing is wrong with the API or your network" - exactly the wrong-direction diagnosis the surrounding comment says this file exists to prevent. Fixed: RATE_LIMITED|Rate limit added to the classifier. ADR-149.

  The original report resolved without a code fix: the countdown itself doesn't misbehave (refusals are never counted, verified by reading routes/rate-limit.ts). The real cause was three things sharing one IP-keyed bucket on localhost at once - a score:watch loop polling every 5s, this session's own testing curls, and every dashboard reload firing 6-8 parallel GETs, which partially refills the window on each attempt. Reloading while blocked adds load rather than relieving it. Stopped the background watcher since it had already caught up. Local-dev-only artifact; flagged in deployment.md as a real risk only if Tejas runs score:watch against Railway from the same laptop he demos from.

- 2026-09-03: at Tejas's direct request after hitting the read rate limit twice in one session, widened it 120 -> 240/min per IP. The original 120 was correctly derived for one real visitor (busiest legitimate screen ~12 requests, poll loop 80/min); what actually fired both times was score:watch's own polling, this session's testing curls, and reload bursts sharing one localhost bucket, never one real judge. Doubled rather than removed - reads cost no money, this tier shields volume not the wallet, 240 is still a small fraction of what a scripted abuser would need. Every load-bearing reference updated together: the constant + its derivation comment, the one test with the number hardcoded, api-contract.md's current-state table, error.tsx's illustrative comment. The unit test suite needed no change - it derives expected values from the constant itself rather than a literal, and all 8 cases stayed green. Historical docs left as written, matching the append-only discipline the project already holds itself to elsewhere. ADR-150.

- 2026-09-03: chasing a question about whether the alias-teach checkbox leaked state across review items (it did not - already fixed once, key={item.matchId} confirmed present) surfaced a much more serious bug while verifying live. Navigating to verify's review queue by its exact run id silently loaded a demo dataset run instead - 74 pending items instead of 47, no error, no indication of a substitution. Cause: resolveRun searched only inside listRuns()'s default 25-item page and treated a miss as "does not exist" rather than "not among the 25 most recent." The 26th run created today pushed verify off page one. verify is the one run this session's rehearsal notes name for a live alias-teaching demo - this would have failed on stage, silently, showing the wrong run with full confidence. Fixed by asking for the specific run directly via getRun when it is not on the default page, before falling back. Verified live: the exact failing URL now matches the API directly. ADR-151.

  Same session, separate fix at Tejas's direct request: teaching an alias and rejecting a match made structurally exclusive, not just discouraged - a useEffect force-clears teachAlias the moment a rejection reason exists, the checkbox disables with an inline explanation, and re-enables cleanly when the reason is cleared. Verified functionally (not just read from source): checked the box, typed a reason, confirmed checked:false and disabled:true landed together, cleared it and confirmed it came back. ADR-152.

- 2026-09-03: added a "go to page" box to Paginate at Tejas's request (flipping through 47 review proposals live is awkward), and the real work was NOT reintroducing a bug this codebase already found and fixed once. Paginate is shared by five server pages plus ReviewQueue (a client component), and only stays safe in both because it carries no 'use client' of its own -- ReviewQueue's own comment already documents that marking a shared component client-side breaks every server-page caller passing it a function prop, identically, everywhere, at once. Built as a plain GET form instead, matching the /exceptions sort form's existing pattern: zero client JS, hrefFor(1) called once server-side to recover the current query params as hidden inputs, never passed onward. Gated on totalPages > 5. Verified present in rendered HTML on both a pure server page (/audit) and the client-wrapped one (/review); production build succeeded, which is itself a check this exact bug class fails; the assembled submission target confirmed to match a URL already known to work. ADR-153.

- 2026-09-03: the dashboard's False Positives and Best Possible tiles only ever refreshed on a manual reload, and Tejas caught the real consequence -- a judge who clicks "Run It Again" and does not know to reload, or runs out of patience first, never sees the honest number arrive even though score:watch measures the run within seconds. Fixed with ScoreReportPoller, deliberately mirroring InvestigationPoller (ADR-116) rather than a new idiom: mounted only while measured is null so it self-unmounts on success, polls one cheap metrics read every 5s and spends a full router.refresh() only once, gives up after 120s with a manual check and a no-JS link. One token fix carried along: the reference component's give-up banner used --sev-medium, the same misuse fixed three times already this session; the new one uses neutral ink instead.

  Verified end to end against real state: deleted a run's score report (backed up first), confirmed the absent tiles and the poller both rendered, and watched score:watch re-score the run on its own cycle before a manual restore was needed. The pane's own javascript_exec caught the poller firing router.refresh() with nobody clicking anything; a direct curl right after confirmed the resulting page correctly shows the measured tiles. The pane itself could not finish rendering that response afterward -- ADR-127's already-documented streaming limitation, not a regression from this change. ADR-154.

- 2026-09-03: added an optional "name this run" field to the launcher, Tejas's own framing as purely cosmetic. Checked first, not assumed, that overriding the label fully is safe: grepped every non-node_modules reference to a run's .label for anything that infers the dataset by parsing the string. One hit, and it compares a dataset's own label from /api/health, never a run's -- everything that needs to know which dataset a run reconciled reads datasetSeed, a real field, so a custom name cannot hide anything from code that depends on it. Same .field idiom as ResolveActions/ReviewCard.

  Verified through the real API path rather than the UI: the interactive click-through needed the pane to hydrate the dashboard, which streams and hit ADR-127's already-documented limitation -- confirmed directly, the button's DOM node had reactKeys: [], meaning the pane never completed hydration at all, not that anything is broken. Posted the exact request startRun sends, with a custom label, waited for real completion, confirmed the dashboard's RUN field shows it verbatim. Stronger proof than a click would have been -- it verifies the whole path, not just that a panel opens. ADR-155.

- 2026-09-03: added "How the Engine Works" to the dashboard -- fourteen stages in four phases, each carrying a real figure from the run being viewed rather than prose. Built as a section, not the new nav tab originally suggested: nav already carries seven items (one past the limit this project set for itself when it kept /set-aside out), and a standalone descriptive page would have had no data on it, making it the first thing on the site to break the rule every fix this session has reinforced -- a claim appears beside its evidence. Four defects caught during the build: the match rate rendered at one decimal against the headline tile's two (two numbers for one quantity on one page); a stage timing broke the column of counts mid-number; the Audit card had no published figure and would have required inventing one for the stage whose whole purpose is provable honesty; and "874 records" was typed into prose, which page.tsx's own rule forbids in as many words and which would have gone stale on the demo dataset's 876. ADR-156.

  The regression check for it then found something worse and unrelated: /?run=<phase4-free> on the dashboard rendered holdout-judge-demo, silently. ADR-151 had fixed exactly that bug three commits earlier -- but in resolveRun, the shared helper six screens use. The dashboard never used it; it kept pickRun, a private copy, and kept the bug on the one page every visitor lands on first. It resurfaced the moment the database passed 31 runs and phase4-free fell off listRuns' page one. On a demo built around bookmarked ?run= links, with a judge-simulation pass planned that will click through them, this would have shown the wrong run's numbers with total confidence. The duplicate is deleted rather than patched -- two copies of one rule is what produced a fix that landed on only one of them. ADR-157.

  > Three defects from one family now: a paginated list mistaken for a lookup table (ADR-151), an error classifier that could not recognise its own error (ADR-149), and a rule living in two places fixed in one (ADR-157). All three were correct in isolation and wrong in composition, none was findable by reading the diff that introduced it, and all three were found by exercising the running product against a known expectation.

- 2026-09-03: "the runs table only shows 25 entries" -- it was worse than a display cap. resolveRun fetches listRuns() with no pageSize, defaulting to 25, and RunPicker's Show all rendered runs.length and called it "All N runs." With 31 in the database the footer read "All 25 runs" -- a false completeness claim, on the one screen this project exists to never make one. The identical bug existed a second time, three lines below the first, in the dashboard's own "N runs recorded" line. Same family as ADR-151 and ADR-157, a third instance of treating a paginated convenience list's length as the truth. Fixed at the source: resolveRun now fetches the API's own documented ceiling (200, MAX_PAGE_SIZE) rather than a second guess, RunContext carries runsTotal from pagination.total (the API's real count, never runs.length), and both display sites read it. Built the honest failure mode rather than assuming it away: if total ever exceeds the 200-row fetch, showAll no longer claims completeness -- it says older runs exist beyond what is listed and points to the audit trail. Verified against the real API count (31), not assumed: 31 rows rendered, footer reads "All 31 runs", dashboard reads "31 runs recorded", collapsed view correctly still reads "Showing 6 of 31". Full ten-route regression re-run since this touches the shared helper all seven screens use. ADR-158.
