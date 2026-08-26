# The Analyst — Agent Design

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4
Status: **Day 4 (second pass) — locked.** Authored to close a gap against the track's problem statement, which asks for an *agent*.
Companion docs: [ARCHITECTURE.md](../ARCHITECTURE.md) · [matching-engine.md](./matching-engine.md) · [adr-log.md](./adr-log.md) (ADR-048…ADR-057) · [validation-strategy.md](./validation-strategy.md)

---

## 0. The gap this closes, stated plainly

The track says **"Build an agent that closes one finance-ops loop."**

As designed through ADR-047, this system is an excellent deterministic rules engine with one LLM call bolted to the end that writes captions for decisions already finalized (S13, ADR-017). Fourteen of fifteen stages are arithmetic, tie-breaks and rule precedence. The single AI touchpoint has a no-op fallback: if the Anthropic API is down, the run completes identically with template strings.

That is not an agent. Calling it one would be the same species of dishonesty this project is otherwise built to avoid — and a panel that reads the architecture will see it in about ninety seconds.

**But the fix cannot be to make the engine agentic.** ADR-017 is load-bearing: accuracy is measurable *because* the rules are deterministic and reproducible. An LLM inside the matching path makes the same dataset produce different numbers on two runs, and the track's "measured accuracy" bar becomes unmeetable. Weakening ADR-017 to satisfy the word "agent" would trade the project's strongest claim for its most fashionable one.

So the agent goes somewhere else.

---

## 1. The idea: the engine reconciles, the Analyst investigates

A real finance-ops team has two things. It has a reconciliation *system*, which matches what can be matched mechanically. And it has an *analyst*, who works the exception queue the system produces — pulling up source documents, chasing a reference number across systems, deciding whether a discrepancy is a real problem or a formatting artifact, and either resolving it or writing down why it cannot be resolved.

This architecture had the first and not the second. **The Analyst is the second.**

```
  ═══════════════ THE ENGINE ═══════════════      ══════ THE ANALYST ══════
  S0 … S14   deterministic · reproducible          A1 … A4  agentic · bounded
  measured against the answer key                  measured against the SAME key
                    │                                        │
                    │  matches, exceptions, evidence         │  proposals with
                    └───────────────────────────────────────►│  reasoning chains
                       (ground truth INPUT to the Analyst;             │
                        never modified by it)                          ▼
                                                              human confirmation
                                                              (endpoints that
                                                               already exist)
```

The Analyst runs **strictly after S14**, as a separate job with its own lifecycle. It reads the engine's output as finished fact. It cannot modify a match, an exception, a confidence score, a category or a metric. It proposes; a human disposes; the existing human-action endpoints (ADR-043) do the writing.

**Why this framing is the right one and not a dodge:** the loop the track asks us to close is *reconciliation*, and reconciliation is not closed when the engine finishes — it is closed when someone has dealt with the exceptions. The engine handles the mechanical half. Nobody had built the judgment half. The Analyst is not an agent bolted onto a finished product to satisfy a rubric; it is the missing half of the actual finance-ops loop.

---

## 2. The design principle everything follows from

> ### The agent chooses which questions to ask. Deterministic code computes every answer.

The Analyst never does arithmetic. It never compares two amounts, never computes a similarity score, never decides that a date falls inside a window, never sums a subset. When it wants to know whether two records match, it calls **the same scorer S9 used** and receives **the same answer S9 would have received**.

What is genuinely agentic is the *strategy*: which records to pull, which hypothesis to test next, which contradiction to chase, when there is enough evidence, and when to stop. What is deterministic is every fact it reasons over.

Three consequences worth being explicit about:

1. **The agent cannot produce a number the engine wouldn't have produced.** Every figure in a reasoning chain came out of locked code.
2. **The agent cannot silently disagree with the engine.** If it thinks two records match, it must show a `score_pair` result saying so — and if the scorer says 0.41, that is what the transcript shows.
3. **Reasoning is auditable at the level of evidence, not just narrative.** "I believe these match" is worthless; "I called `score_pair` on these two ids and got 0.87 with the anchor component at 0.30" is checkable by anyone.

This is also what makes the agent honest about the thing it is most tempted to lie about — whether it actually found anything.

---

## 3. Phase A — the four stages

Engine stages are numbered `S`. Analyst stages are numbered `A`. The separation is deliberate and visual: nothing in `A` may appear in `S`.

```
A1  TRIAGE      deterministic selection + ordering of exceptions to investigate
A2  INVESTIGATE the agent loop — plan → tool call → observe → continue → verdict
A3  VALIDATE    deterministic grounding gate: schema, citations, constraints
A4  PROPOSE     persist verdicts; surface proposals into the human review queue
```

### A1 — Triage (deterministic)

The Analyst does not investigate everything; investigation costs tokens and time. Selection is **deterministic and reproducible even though the investigations themselves are not**:

- Eligible categories: `AMBIGUOUS_MATCH`, `UNSPLITTABLE_BATCH`, `MISSING_IN_BANK`, `MISSING_IN_LEDGER`, `MISSING_IN_GATEWAY`, `AMOUNT_MISMATCH`. (`DUPLICATE_RECORD` and `TIMING_DRIFT` are excluded: the engine's verdict on those is already complete and an agent adds nothing.)
- Ordered by `severity DESC, amount_at_risk_paise DESC, (source_system, source_row_number) ASC` — the canonical tie-break from ADR-032.
- Capped at `AGENT_MAX_INVESTIGATIONS_PER_RUN` (default **20**).

**The Analyst is never told which exceptions are designed-unresolvable.** It investigates them like any other, and is expected to conclude `CONFIRMED_UNRESOLVABLE`. That is the honesty test in §7.

### A2 — Investigate (agentic)

A tool-use loop over one exception. Anthropic SDK tool-use, `claude-sonnet-5`, `temperature: 0`, static cached system prefix (ADR-019 unchanged — Opus is still never called at runtime).

```
  system prompt (static, cached: role, tool contract, verdict schema, honesty rules)
        +
  user message: the exception, its evidence, the engine's rejection reasons
        │
        ▼
  ┌── plan ──► tool call ──► observe result ──► continue or conclude ──┐
  └────────────────────── up to 10 steps ─────────────────────────────┘
        │
        ▼
  structured verdict (JSON, schema-validated in A3)
```

Every step is written to `audit_log` as it happens (§6), so a partial investigation that hits a budget still leaves a complete, ordered, tamper-evident record of what it did.

### A3 — Validate (deterministic gate)

**The agent's output is untrusted until it passes a non-LLM gate.** This is the mechanism that turns "we hope it doesn't hallucinate" into "hallucination is structurally detected."

Three checks, all deterministic:

| Check | What it enforces |
|---|---|
| **Schema** | The verdict parses against the JSON schema; enum values valid; required fields present. |
| **Citation grounding** | Every `transactionId`, `matchId` or `sequenceNo` cited in the reasoning chain **must appear in the result of a tool call this investigation actually made.** An id the agent never retrieved is an id it invented. |
| **Constraint** | A `MANUAL_MATCH` proposal must name records that are in this run, currently unmatched, in the same direction, and in distinct source roles. A `CREATE_ALIAS` proposal must not contradict an active alias without flagging it. |

Any failure downgrades the verdict to `INSUFFICIENT_EVIDENCE` with `groundingFailure: true`, records the reason, and **does not retry** — a second attempt at a hallucinated answer is still an attempt at a hallucinated answer. Grounding failures are counted and reported (§7); a rising count is a signal the prompt or tools need work, not something to suppress.

### A4 — Propose

Verdicts are persisted to `agent_investigations`. Proposals appear in the UI attached to their exception, and are actioned by a human through endpoints that **already exist**:

| Proposed action | Routes to |
|---|---|
| `MANUAL_MATCH` | `POST /api/runs/:runId/matches` (endpoint 21, ADR-043) |
| `CREATE_ALIAS` | `POST /api/aliases` (endpoint 16) |
| `MARK_WONT_FIX` | `POST /api/exceptions/:id/resolve` (endpoint 20, ADR-043) |
| `ADJUST_SEARCH_BOUNDS` | already applied during investigation; the improved evidence is attached to the exception |

**Zero new write endpoints.** The Analyst proposes into an inbox that already has a confirmation flow, an audit trail and a UI. That is most of why this layer is buildable in the time available.

---

## 4. The tool registry

Nine tools. **None of them writes.** The registry contains no mutating tool, so the agent is not *trusted* not to write — it is *unable* to.

### Evidence retrieval

| Tool | Purpose |
|---|---|
| `get_exception(exceptionId)` | The exception, its full `evidence`, the engine's per-candidate `rejectedBecause` strings, severity basis. The starting point of every investigation. |
| `get_transaction(transactionId)` | Normalized fields plus `raw_payload` — the verbatim original row. Lets the agent read what the parser read. |
| `search_transactions({sourceSystem?, dateRange?, amountRange?, direction?, counterparty?, statusNorm?, limit})` | The workhorse. Bounded at 50 results, always canonically ordered. |
| `find_by_anchor({value, exact\|near})` | Cross-source anchor lookup, including edit-distance-1 near matches via the existing prefix block (ADR-031). The single most useful tool for `MISSING_IN_*` cases. |
| `get_audit_trail({subjectType, subjectId})` | **Why the engine did what it did.** The agent can read the engine's own reasoning before forming its own — which is how it avoids re-deriving a conclusion the engine already recorded. |
| `find_similar_exceptions({category\|signatureHash, limit})` | Prior exceptions of the same shape, including any human resolutions. Institutional memory. |

### Deterministic computation — the agent asks, locked code answers

| Tool | Purpose |
|---|---|
| `score_pair({transactionIdA, transactionIdB})` | Runs **the same Tier 2 scorer S9 used**. Returns the component breakdown and which hard gate failed, if any. The agent's only route to "would these match?" |
| `rerun_subset_search({bankTransactionId, poolSize, maxSubsetSize, budgetMs})` | Runs **the same S10 meet-in-the-middle** with agent-chosen bounds, subject to hard ceilings (pool ≤ 64, subset ≤ 10, budget ≤ 2000 ms) the agent cannot exceed. This is the self-correction surface (§5). |
| `check_alias({value})` | Looks up `learned_aliases`, returns any active mapping plus the `wouldAlsoResolve` count for a proposed one. |

**Result digests, not raw dumps.** Tool results are shaped for a model — bounded row counts, pre-formatted amounts (`amountDisplay`, per api-contract §0), no `raw_payload` unless explicitly requested. A tool that can return 800 rows can exhaust a context window and produce a worse answer than one that returns 20 and says how many it truncated.

---

## 5. Self-correction, concretely

The generic version of "self-correction" is a slogan. Here is the specific case the design targets, and it is a good one because the engine's honest dead-end is already documented.

**The setup.** S10 attempts to decompose a bank `SETTLEMENT` credit into the gateway payments that net to it. Bounds: pool ≤ 24, subset ≤ 8, 250 ms. When a bound binds, the exception records `searchBoundExceeded: true` — deliberately distinct from `searchExhausted: true`, because *"I proved no combination works"* and *"I gave up after 250 ms"* are different claims (ADR-038).

`searchBoundExceeded` is, by design, an honest dead end. The engine cannot widen its own bounds — bounds that adapt per-record would make throughput unpredictable and the result harder to reproduce.

**What the Analyst does with it.**

```
step 1  get_exception            → UNSPLITTABLE_BATCH, searchBoundExceeded,
                                   bound hit = pool cap 24, credit ₹4,82,110
step 2  search_transactions      → 31 unmatched gateway credits in the window,
                                   19 sharing this counterparty
        observe: the pool was truncated by date proximity, and 7 same-counterparty
        payments fell outside the 24 nearest — the truncation was arbitrary here
step 3  rerun_subset_search      → poolSize 48, maxSubsetSize 8, budgetMs 1500,
                                   filtered to the counterparty
        result: exactly one subset of 6 payments sums into the credit band
step 4  score_pair (spot-check)  → confirms each member is otherwise unmatched
step 5  conclude                 → RESOLUTION_PROPOSED, MANUAL_MATCH, 6+1 members,
                                   confidence: high, citations: 7 transaction ids
```

**Both outcomes are wins, and this is the part worth understanding.** If the wider search finds a decomposition, an exception the engine could not resolve becomes a human-confirmable match. If it finds nothing, the exception is *upgraded* from `searchBoundExceeded` to `searchExhausted at 2× bounds` — the engine's weakest honest claim becomes its strongest one. **A failed investigation improves the exception list**, which is precisely what the track grades. There is no outcome where this is wasted work.

The same pattern generalizes: the agent's job on a dead end is to determine whether the dead end is a property of the data or a property of the engine's bounds, using the engine's own code to find out.

---

## 6. Verdicts, and the shape of a reasoning chain

### Verdict types

| Verdict | Meaning |
|---|---|
| `RESOLUTION_PROPOSED` | A concrete, human-confirmable action with cited evidence. |
| `CONFIRMED_UNRESOLVABLE` | The agent investigated and agrees with the engine, **with a stated reason why**. Not a failure — the most important verdict in §7. |
| `NEEDS_EXTERNAL_DATA` | Resolvable in principle, but requires a document this system does not have (a settlement advice, a refund file, a chargeback notice). Names what is needed. |
| `INSUFFICIENT_EVIDENCE` | Could not determine within budget, or failed the A3 gate. Carries `budgetExhausted` / `groundingFailure`. |

`NEEDS_EXTERNAL_DATA` earns its place: in real finance ops it is the most common honest answer, and an agent that cannot say it will fabricate one of the other three.

### Confidence is a label, never a number

`high | medium | low`. **Deliberately not numeric**, and deliberately typologically different from the engine's `NUMERIC(5,4)` confidence. A model-produced 0.87 next to a computed 0.87 invites averaging, sorting and comparison between two things that are not the same kind of quantity. Keeping them different shapes makes that mistake impossible to make by accident.

### The reasoning chain

Persisted as an ordered list of steps, each carrying the tool called, its arguments, a digest of what came back, and the inference drawn. Rendered in the UI as a chain a human can follow and re-check by clicking through to the cited records.

**Every claim carries its citations, and A3 verifies they were actually retrieved.** The chain is not narration written after the fact; it is the transcript of what the agent did, in order, with the evidence it saw.

---

## 7. How the Analyst is measured

This is the section that makes the layer defensible rather than decorative. **The Analyst is scored against the same answer key as the engine, which it cannot read** (ADR-021 is unchanged and still enforced by the import grep).

The validation strategy already contains the metric the Analyst exists to attack:

> **False-despair rate** — of the events the engine gave up on, how many were actually `RESOLVABLE`? *"This is the honest measure of the engine's headroom, and the right place to look for the next day's work."* — validation-strategy §5.3

The Analyst *is* the next day's work, and the false-despair set is exactly its addressable market. Four measurements follow:

| Metric | Definition | Bar |
|---|---|---|
| **False-despair recovered** | Of the engine's false-despair exceptions (key says `RESOLVABLE`, engine left unmatched), how many did the Analyst propose a *correct* resolution for? | The headline. This is the agent's entire reason to exist. |
| **Proposal precision** | Of all `RESOLUTION_PROPOSED` verdicts, how many does the key confirm? | Reported as a raw fraction, never rounded away. |
| **Hallucinated resolutions** | Proposals on events the key marks `UNRESOLVABLE`. | **Must be 0. Build blocker, not a metric.** |
| **Unresolvable agreement** | Of designed-`UNRESOLVABLE` exceptions investigated, how many got `CONFIRMED_UNRESOLVABLE`? | High is good; low means the agent is guessing under pressure. |

**Why the hallucination bar is a build blocker.** The dataset contains ~21 events that are impossible to resolve for any correct engine *and any competent human* — verified by assertion during generation, not merely labelled (validation-strategy §4). An agent that proposes a resolution for one of them has invented evidence. That is strictly worse than the engine's silence, because it arrives wrapped in a confident reasoning chain. It is the single most damning failure available to this layer and it is treated exactly as the engine's equivalent is: as something that stops the build, not something that gets a percentage next to it.

**Operational metrics** (no ground truth, computed from `agent_investigations`): investigations run, verdict distribution, mean steps and tool calls, grounding-failure count, budget-exhaustion count, tokens and cost per investigation, cache hit rate on the static prefix.

### The reporting rule

**Analyst proposals never enter the engine's match rate.** Not before human confirmation, and not after. A human-confirmed agent proposal becomes a `manual` match, which ADR-043 already excludes from engine match rate for exactly this reason. The accuracy report shows two blocks:

```
ENGINE      (deterministic, measured)
  Match rate 82.4%  ·  Precision 0.988  ·  False positives 5
  Exceptions 65     ·  Unresolvable correctly identified 21/21

ANALYST     (agentic, measured against the same key)
  Investigated 20 of 65 exceptions
  False-despair recovered   14 of 22   ·  Proposal precision 16/18
  Hallucinated resolutions  0          ·  Unresolvable agreement 6/6
  Mean 6.2 steps · 8.4 tool calls · $0.03 per investigation
```

Two numbers, two provenances, never merged. Same discipline as cold vs warm (ADR-020) and engine vs manual (ADR-043) — this project already reports paired figures three times; this is the fourth, and it is consistent rather than novel.

---

## 8. Bounded agency

An unbounded agent loop against a paid API on a public demo URL is a financial and reputational risk, not a feature.

| Bound | Default | On exhaustion |
|---|---|---|
| Steps per investigation | 10 | `INSUFFICIENT_EVIDENCE`, `budgetExhausted: true` |
| Tool calls per investigation | 16 | as above |
| Wall clock per investigation | 60 s | as above |
| Investigations per run | 20 | remaining exceptions simply aren't investigated; counted and reported |
| Tokens per investigation | 40 k | as above |
| Cost per run | `AGENT_MAX_COST_USD_PER_RUN`, default 1.00 | phase stops, partial results retained |

**Budget exhaustion is an honest verdict, never a fabricated conclusion.** This mirrors `searchBoundExceeded` exactly: the system says which bound stopped it. An agent that produces its best guess when it runs out of room is worse than one that says it ran out of room.

The static system prefix — role, tool contract, verdict schema, honesty rules — is a **cacheable prefix** (Anthropic prompt caching), reused across every investigation in a run. That is the difference between an affordable phase and an expensive one.

---

## 9. The Q&A agent

The track's own example directions include a *"Settlement Q&A agent."* The tool registry from §4 is already the hard part, so this is a second loop over the same tools rather than a second system.

`POST /api/runs/:runId/ask` → `{ question }` → `{ answer, citations[], toolCalls[], steps, costUsd }`

Read-only tools only (`rerun_subset_search` is excluded — a question should not spend a 2-second compute budget). Same grounding gate: an answer citing a record it never retrieved is rejected before it reaches the client. Bounded at 6 steps and 8 tool calls.

Questions like *"why wasn't settlement SBIN0R52… matched?"*, *"show me every exception over ₹10,000"*, *"which merchant has the most unmatched records?"* are answered by real queries against the run's actual data, with clickable citations — not from a canned report.

**The UI seeds four example questions.** A blank text box in a five-minute pitch is a way to lose thirty seconds and discover a question the agent answers badly.

### A safety regression this creates, and the fix

[deployment.md](./deployment.md) §4 currently claims: *"There is no user-facing 'ask the AI' box, so there is no path for an anonymous visitor to burn quota."* **This endpoint makes that claim false**, and the deployed demo has no auth by design (ARCHITECTURE §5).

Leaving a stale safety claim in a document would be precisely the kind of quiet dishonesty this project exists to avoid, so the claim is corrected and mitigated:

- `AGENT_QA_MAX_QUESTIONS_PER_RUN` (default 50) — a hard per-run ceiling
- `AGENT_QA_MAX_QUESTIONS_PER_HOUR` (default 100) — global token bucket across the deployment
- Max 6 steps and 1024 output tokens per question
- `AGENT_QA_ENABLED` kill switch, flippable without a deploy
- Questions and costs are logged, so abuse is visible rather than inferred from a bill

This is the same cost-containment posture as `LLM_MAX_CALLS_PER_RUN` (ADR-018), extended to an interactive surface.

---

## 10. What was considered and deliberately rejected

| Rejected | Why |
|---|---|
| **An auditor agent that reviews auto-confirmed matches for false positives** | Genuinely tempting, and it would attack precision rather than recall. Rejected because it puts the model in a position to second-guess a finalized engine decision, which is the boundary this whole design exists to hold. False positives are found by the scorer against ground truth — a measurement, not an opinion. |
| **Agent-in-the-loop during matching** (e.g. consulted at the ambiguity guard) | Directly violates ADR-017 and makes the engine's output non-reproducible. The ambiguity guard's value is that it *refuses* to decide; handing that decision to a model destroys the thing that makes it valuable. |
| **Letting the agent write to the database directly** | The read-only tool registry is a stronger guarantee than any instruction in a prompt. Proposals route through human confirmation because that is what makes them safe, not because it is convenient. |
| **A multi-agent framework** (planner/researcher/critic) | Out of scope per ARCHITECTURE §5, and it would be ceremony: one loop with nine tools and a deterministic validation gate does this job. The "critic" is A3, and A3 is better than a critic because it is code. |
| **Numeric agent confidence** | False precision, and it invites comparison with computed scores. §6. |
| **Agent-tuned tolerances or thresholds** | Would make the engine's config a function of model output, destroying reproducibility from `config_snapshot`. The agent may *observe* that a bound was binding; it may not change the shipped default. |
| **Streaming the agent's reasoning to the UI live** | Nice demo texture, real transport complexity, and ADR-024 already rejected realtime transports for the same reason. The chain renders after completion. |

---

## 11. Build scope

Deliberately small, because most of it already exists.

| Piece | Notes |
|---|---|
| Tool registry (9 tools) | Thin wrappers over repository functions the engine needs anyway. Built Day 10 alongside the classifier. |
| Investigation loop (A2) | One Anthropic tool-use loop. The SDK handles the turn cycle. |
| Grounding gate (A3) | Pure functions. The highest-value tests in the suite (testing-strategy §1.6). |
| Two tables | `agent_investigations`, `agent_questions`. Traces reuse `audit_log` (ADR-052). |
| Four endpoints | 25–28. **No new write endpoints** — proposals route through 16, 20, 21. |
| UI | One panel on exception detail, one dashboard block, one Q&A box. |

### Degradation order, decided in advance

Same discipline as ui-spec §8 — the decision made under time pressure is always to cut the thing that is hardest to finish, which is why it is made now instead:

1. **Must ship** — investigation agent on `AMBIGUOUS_MATCH` and `UNSPLITTABLE_BATCH`, the grounding gate, the audit trace, agent scoring against the key. These two categories carry the best demo and the self-correction story.
2. **Ship plain** — investigation across the remaining eligible categories; reasoning-chain UI unstyled.
3. **Cut first** — the Q&A agent. It is the most *demoable* piece and the least *defensible* one; if something must go, it is the thing that impresses rather than the thing that measures.

If the Analyst cannot ship at all, the engine still stands on its own and the submission is honest about what it is. Nothing in Phase A is a dependency of anything in the engine.
