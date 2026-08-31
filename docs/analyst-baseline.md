# The Analyst — first measured baseline

**Recorded 2026-08-31 · `gemini-3.1-flash-lite` · holdout run `80ddde9d-af94-49e5-b873-5382f4a515c0`**

Machine-readable ledger: [`data/baselines/analyst-gemini-3.1-flash-lite.json`](../data/baselines/analyst-gemini-3.1-flash-lite.json)
Reproduce: `npm run analyst -- --run <runId> --model <model> --out <path>` (`--dry-run` costs nothing)

---

## What this is, and what it is NOT

**It is** the first end-to-end execution of Phase A over a full triaged work list, and a record of
what it cost and how it behaved: requests, tokens, latency, verdicts, grounding outcomes.

**It is not an accuracy measurement.** `tools/score` does not score the Analyst yet, so
`validation-strategy.md` §7's figures — false-despair recovered, proposal precision, unresolvable
agreement — still do not exist. Nothing here should be read as "the Analyst is N% correct".

**It is not a preview of the shipped model.** Flash Lite was chosen for its 500 requests/day, which
is the only free-tier allowance large enough for a full run. Verdict *quality* on Flash Lite
predicts nothing about Opus 5. Verdict *plumbing* does, and that is what this measures.

---

## The engine did not move (ADR-048)

```
284 matches · 212 exceptions · 612 audit entries · matchRatePct 65.22
```

Identical to the figures in CLAUDE.md. Phase A read the engine's output and changed none of it.

---

## Headline

```
investigated          20 of 21 eligible      corroborated  10 of 15 (5 cut by the request budget)
verdicts              INSUFFICIENT_EVIDENCE 19 · CONFIRMED_UNRESOLVABLE 1
grounding passed      1 of 20 investigations · 0 of 10 corroborations
audit entries         309
```

**One investigation produced a complete, grounded verdict** — `CONFIRMED_UNRESOLVABLE`, high
confidence, 3 citations, 10 steps, A3 gate passed. The loop, the gate, the citation plumbing and
the persistence path all work end to end. The other nineteen failed for reasons that are diagnosed
below and are **not** "the agent cannot do this".

---

## Spend and pacing

```
requests issued       216      retries 0      429s 0
requests spent        216      (issued == spent: the pacing layer's true count)
tokens                1,138,165 in · 21,519 out
throttle wait         569,933 ms   of a 1,122,751 ms phase (51%)
cost                  null — free tier, and NOT invented
projected on Opus 5   $6.23   ← a PRICE projection of these exact token counts, not a behaviour
                              prediction; a different model produces different token counts
```

**The pacer worked exactly as designed: 216 requests, zero retries, zero rate-limit rejections.**
Half the wall clock was deliberate waiting. That is the trade U14 was built to make — a refused
request still costs quota, so paying in latency to never be refused is the cheaper side.

---

## Latency — the ADR-086 measurement

```
per turn      min 994 ms · median 2,323 ms · p95 4,689 ms · max 8,682 ms   (216 turns)
```

`agent-design.md` §8 bounds a whole investigation at 60 s. At the median a 10-step investigation
spends **23 s** in the model and at p95 **47 s** — inside the bound, but with less headroom than
the bound's author assumed. **This figure must be re-measured before any provider is adopted**;
that is ADR-086's rule and this is the first time the repo has satisfied it.

Note the pacer's sleep is excluded: the timing decorator wraps the provider client *inside* the
limiter, so a throttle wait is never counted as model latency.

---

## Why nineteen investigations failed

The loop names the bound that stopped it, so this is read from the audit log, not inferred.

| Stop cause | n | What it means |
|---|---|---|
| `40000-token ceiling` | **15** | Killed mid-reasoning, before any verdict existed |
| model concluded on its own | 4 | Reached a verdict; the A3 gate then rejected it |
| model concluded, gate passed | 1 | The one good verdict |

And the grounding failures those produced:

| Grounding failure | n | What it means |
|---|---|---|
| `schema: verdict must be one of …` | 15 | No verdict to check — the budget had already killed it |
| `schema: proposedAction must be an object` | 1 | Malformed verdict |
| `reasoning step N has no matching tool call` | 2 | **A real hallucination, caught** |
| `reasoning step 2 reports a result the runtime did not record` | 1 | **A real hallucination, caught** |

**Three hallucinations, all caught by the A3 gate, none persisted as a resolution.** ADR-053's
build blocker is no longer a design argument with a single anecdote behind it — it has fired four
times now across two models.

---

## DEFECT 1 — the token bound is a spend guard doing a work guard's job

`AGENT_DEFAULTS.budget.maxTokens` is 40,000, checked at
[`investigation-loop.ts`](../apps/api/src/services/agent/investigation-loop.ts) as
`usage.tokensIn + usage.tokensOut >= budget.maxTokens`.

`tokensIn` is **summed per turn**, and every turn resends the whole conversation. So the counter
grows quadratically in steps: a 10-step investigation re-reads its own history ten times. Measured
trajectories from this run:

```
 7 steps → 67,193 tokens      (a tool-heavy investigation)
 8 steps → 41,632 … 51,396
 9 steps → 46,061 … 46,796
10 steps → 53,537             (the one that finished)
```

40,000 therefore buys roughly **7–9 steps**, and `maxSteps: 10` is unreachable for most
investigations. The two bounds in §8 are mutually inconsistent and nothing said so, because a fake
client returns a fixed small usage per turn and 741 tests never noticed.

The spread at equal step counts (41,632 vs 51,396 at 8 steps) is tool-payload variance —
`rerun_subset_search` returns far more than `get_exception` — so no single token number makes
`maxSteps` reliably reachable. **That is the real finding: cumulative billed tokens is the right
shape for a SPEND bound and the wrong shape for a WORK bound, and it is currently serving as both.**

---

## DEFECT 2 — the agent cannot see the bound that actually stops it

[`investigation-loop.ts`](../apps/api/src/services/agent/investigation-loop.ts) computes the
model's pacing signal from steps alone:

```ts
const remaining = budget.maxSteps - steps;
```

So at step 8 the model is told *"2 steps left. Wrap up"* — and is then killed by the token ceiling
it was never shown. The `remaining === 0` branch carrying **"FINAL STEP. Do not call any more
tools. Write your verdict JSON now"** is unreachable whenever tokens bind first, which was 15 of
20 times.

This is why `tool_calls == steps` in every exhausted investigation. The model is not failing to
stop; it is being instructed to keep going until the moment it is silently terminated.

The comment above that line already records that this went wrong twice in live runs — no countdown
and the model never concluded, an urgent countdown and it fabricated a tool call. This is the same
lesson through a third door: the countdown is now right in tone and measures the wrong bound.

> **The cheapest fix is also the best one.** A bound that fires should switch the model to
> "conclude now" rather than hard-break. Cutting off at step 8 discards eight steps of real
> retrieval; telling the model at step 8 that it must conclude recovers a verdict from exactly the
> same work. The file's own words: *"being cut off loses work, answering early invents it."*
> There is a third option it does not currently take.

---

## DEFECT 3 — corroboration grounding fails 10 out of 10, identically

```
10 of 10 corroborations · grounding: "reasoning step 1 has no matching tool call"
```

A 100% uniform failure at the same step with the same message is a defect signature, not a model
signature. Every corroboration reached a verdict (`NO_NEW_EVIDENCE` ×10, at 5–6 steps) and every
one was rejected because its first reasoning step referenced a tool call the runtime had no record
of. The corroboration path was added on Day 12 with its own table and vocabulary (ADR-081,
ADR-087); its grounding wiring appears not to thread tool-call records the way A2's does.

This is the single highest-value thing for AUDIT-3 to confirm, because it means **the entire
corroboration feature has never once produced an accepted result.**

---

## What to carry into the Anthropic swap

1. **Re-measure per-turn latency against §8's 60 s bound before adopting Opus 5** (ADR-086).
   Flash Lite's median is 2.3 s; a thinking model will not match that.
2. **Fix defects 1 and 2 before spending money.** Fifteen of twenty investigations on the paid
   model would otherwise be killed mid-reasoning at roughly $0.30 each, buying nothing.
3. **Token counts will not transfer.** $6.23 is what *these* token counts would cost at Opus 5
   rates. Opus 5 emits thinking tokens, billed as output at 5× the input rate, and Flash Lite
   emitted only 21,519 output tokens across 216 turns. Treat the projection as a floor.
4. **This file is the "before".** Re-run `npm run analyst` after the swap and diff the ledger.
