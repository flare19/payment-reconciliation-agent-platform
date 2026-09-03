# The Analyst — measured on Claude Sonnet 5

**Recorded 2026-09-01 · `claude-sonnet-5`, `AGENT_EFFORT=low` · holdout run `771829ef-a78b-4efd-89c2-e4d51c3d322f`**

Supersedes the earlier `gemini-3.1-flash-lite` baseline as the current provider's record.
The machine-readable "before" ledger is committed at
[`data/baselines/analyst-gemini-3.1-flash-lite.json`](../data/baselines/analyst-gemini-3.1-flash-lite.json).

---

## What this is, and what it is NOT

**It is** the first end-to-end execution of Phase A against a paid model, after AUDIT-3's three P1s
and #52 landed — a record of what the plumbing does, what it costs, and how it behaves.

**It is NOT an accuracy measurement.** `tools/score` still does not score the Analyst, so
`validation-strategy.md` §7's figures — false-despair recovered, proposal precision, hallucinated
resolutions, unresolvable agreement — **still do not exist**. Nothing here says the Analyst is
N% correct. Verdict *quality* is unjudged; verdict *plumbing* is what this measures.

---

## The engine did not move (ADR-048)

```
284 matches · 212 exceptions · matchRatePct 65.22
precision 1.0000 · FP 0 · recall 0.6075 · macro P 0.9286 / R 0.8738
unresolvable recall 1.0 over 21 · exit 0, every honesty gate passed
```

Identical across all six runs made today, keyless and keyed. Phase A read the engine's output and
changed none of it.

---

## Headline

```
investigated       10 of 11 eligible        corroborated  5 of 5
grounding passed   7 of 10 investigations   5 of 5 corroborations
verdicts           NEEDS_EXTERNAL_DATA 5 · CONFIRMED_UNRESOLVABLE 2 · INSUFFICIENT_EVIDENCE 3
corroborations     CORROBORATED 3 · NO_NEW_EVIDENCE 2
cost               $1.16   ·  52 requests  ·  381,599 in / 31,127 out
latency            median 4,849 ms · p95 19,896 ms · max 22,936 ms  (§8 bound: 60,000 ms)
tokens/investigation  41,273
```

Against the Gemini baseline: **grounding passed 1 of 20 investigations and 0 of 10
corroborations.** It is now 7 of 10 and 5 of 5.

---

## What each open acceptance criterion now shows

| | Verified | Evidence |
|---|---|---|
| **#52** S13 grounding | ✅ | 21/21 signatures generated live; **zero** `ungrounded_specific` rejections across 212 exceptions. No false positives on genuine prose. |
| **#53** `RESOLUTION_PROPOSED` reachable | ✅ | Two investigations produced a `MANUAL_MATCH` proposal that passed **schema and grounding** and was refused only at the **constraint** check — the record was already in an `auto_confirmed` match. Reachable, and correctly refused. |
| **#54** grounding join | ✅ | Corroboration grounding went **0/10 → 5/5**. |
| **#55** subset-search pool | ✅ | S10's own population, **54 records** where `unmatchedOnly` gave 14. |
| **ADR-086** latency | ✅ | Median 4.8 s/turn; a 10-turn investigation ≈ 48 s against the 60 s bound. Measured before adoption, which is the rule's whole point. |

**On #53, stated precisely.** A proposal was *produced* and *grounded*; none was *accepted*. Both
were refused because the model proposed matching a record the engine had already matched. That is
ADR-053's guard working — a deterministic gate catching a proposal a human would have had to
reject — not evidence that proposals are correct. **Proposal precision remains unmeasured.**

---

## Five defects only a live model could find

Each was invisible to 818 passing tests, and each cost real money to surface.

| Cost | Defect |
|---|---|
| $0 | The CLI read `GEMINI_AGENT_MODEL` under `LLM_PROVIDER=anthropic` — a Gemini model id sent to the Anthropic API. Caught by `--dry-run`. |
| $0.017 | The explain client lost 2 of 3 batches to unparseable JSON: the Gemini client constrained output with a response schema and the port carried the request but not the constraint. |
| $0.238 | Investigations lost 2 of 2 to prose instead of verdict JSON, and `max_tokens` counts **thinking** tokens — a turn can spend its whole allowance reasoning and return a half-written verdict. |
| $0.232 | The `resultDigest` A3 requires echoed verbatim was **1,192 characters**. A gate that rejects honest work because the token it demanded was impractical to carry is measuring our design, not the model's honesty. |
| $1.07 | Shortening the digest made it *look* like a record id, and 6 of 10 investigations cited the checksum. The gate was right; the prompt had never said what an id looks like. |

> **The signature moved every time, and that is the evidence.** `no matching tool call` (10/10) →
> `digest mismatch` → `citation is a digest` (6/10) → grounded. A fix confirmed by errors *stopping*
> is indistinguishable from a suppressed symptom; a fix confirmed by the error *changing shape* is
> not.

---

## What is still not known

- **Proposal precision, false-despair recovered, unresolvable agreement, hallucinated resolutions.**
  All four need `tools/score` to score the Analyst. It does not.
- **Whether `NEEDS_EXTERNAL_DATA` ×5 is honest or evasive.** It is now grounding-gated (#58 requires
  a reasoning chain), so it is not free — but five of seven grounded verdicts choosing the "I need a
  document you do not have" answer is a distribution worth reading against the key before it is
  quoted approvingly.
- **Three investigations still fail.** Two on the constraint above, one truncated at the token
  ceiling. The prose-twice failure is gone.

---

## Reproduce

```
npm run smoke                                   # ~$0.003, proves key + tool round-trip + latency
npm run analyst -- --run <id> --dry-run          # free, sizes the run
npm run analyst -- --run <id> --out report.json
```

Total spend producing this document, including four engine runs and two discarded Analyst runs:
**$2.83**.


---

## The Q&A loop (U15), measured 2026-09-03

Four live questions against run `55b43a7f` on `claude-sonnet-5`. **Total $0.3323.**

| # | Question | Steps | Tools | Grounded | Verified against the DB | Cost |
|---|---|---|---|---|---|---|
| 1 | Which merchant has the most unmatched records? | 3 | 3 | yes | **partly wrong** | $0.1023 |
| 2 | *(same question, repeated)* | 2 | 8 | no — empty | gate refused it | $0.0466 |
| 3 | Why was `pay_oI87KAfBTaYoZI` not matched? | 5 | 5 | yes | **WRONG** | $0.0717 |
| 4 | Largest unmatched amount, and why did it fail? | 4 | 3 | yes | **correct** | $0.1117 |

Cost: min $0.0466 · max $0.1117 · mean **$0.0831** over n=4. The UI's confirm step now says
"about $0.08" on this basis. Latency 10–30 s, inside the synchronous contract.

### GROUNDED IS NOT CORRECT, AND #3 IS THE PROOF

Question 3 asked why a record was not matched. The agent answered that the record *is not an
exception at all* and that "the underlying premise doesn't appear to hold". The record is
exception `b859a883`, category `MISSING_IN_LEDGER`. **The answer passed the A3 gate while being
false.**

That is not a gate failure. A3 checks that every cited id came back from a tool this
investigation really called — it is a retrieval check, and it did its job: the ids were real.
Nothing in the design ever claimed the gate validates conclusions, and this is the first live
demonstration of the difference. Any claim that grounding implies correctness is unsupported by
this run, and #4 — grounded *and* verified correct — does not license it either.

### THE CAUSE IS A TOOL GAP, AND THE AUDIT TRAIL NAMES IT

The trail written by `answerOne` (U15 unit 3) records exactly five calls for #3:

```
1 find_by_anchor      {"value":"pay_oI87KAfBTaYoZI"}      -> found the transaction
2 get_transaction     {"transactionId":"01a2a8ad-..."}    -> read it
3 search_transactions {"counterparty":"MAKEMYTRIP",...}   -> did not surface it
4 get_audit_trail     {"subjectType":"transaction",...}   -> zero entries
5 search_transactions {"amountMinPaise":49900,...}        -> did not surface it
```

It never called `get_exception`, because **no tool maps a transaction to its exception.**
`get_exception` takes an `exceptionId`, and there is no path from a payment id to one. So the
agent did the reasonable thing with the tools it had, found nothing, and concluded the record was
not an exception.

*"Why wasn't X matched?"* is §9's own first example question and the single most likely thing a
judge will type. The gap is one tool wide.

Question 4 met the same gap and handled it honestly — it stated what `anchorStrength: none`
supported and said plainly it could not retrieve the engine's own categorised reason. Same
missing tool, two different outcomes, which is what an unbounded natural-language surface does.

### The other failure: a tool budget spent without an answer

Question 2 issued **8 tool calls across 2 steps** and returned an empty answer for $0.0466. The
budget is 6 steps and 8 tool calls (§9); the model batches several calls per turn, so the
tool-call ceiling binds first and can bind before anything is written. The gate correctly refused
the empty result. The same question succeeded at 3 calls minutes earlier — the behaviour is not
deterministic, and both outcomes are in the table above rather than only the flattering one.

### What this does NOT establish

n=4, one run, one model, questions chosen by the author. Two answers were verified against the
database, one partly and one fully; #1's headline is defensible only under exact-counterparty
reading and its count was off by one (17 claimed, 16 actual), and under merchant normalisation
MAKEMYTRIP leads with 21. There is no precision figure for the Q&A loop and this table is not
one.
