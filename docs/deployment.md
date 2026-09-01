# Deployment

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4
Status: **Locked.** Revised by the Day 3 design review (ADR-046) and by **ADR-061** (Day 4), which defers the first deploy until the project runs end-to-end locally — Day 11 for the API, Day 12 for the web app. Everything below is unchanged execution detail; only the *timing* moved.
Companion docs: [adr-log.md](./adr-log.md) (ADR-005, ADR-026, ADR-046) · [api-contract.md](./api-contract.md)

**No Kubernetes. No container orchestration. No Dockerfiles authored by us.** Per ADR-005, K8s is parked as a separate future learning project — it earns zero points against this rubric. This is a managed-platform deploy: two dashboards, two `git push`es.

---

## 1. Topology

```
┌─────────────────────────┐        ┌──────────────────────────────────────┐
│  Vercel                 │        │  Railway (one project)               │
│  ─────────              │        │  ────────────────────                │
│  apps/web               │  HTTPS │  ┌────────────────┐  ┌────────────┐  │
│  Next.js (static +      │ ──────►│  │ apps/api       │  │ PostgreSQL │  │
│  client-side fetch)     │  CORS  │  │ Node 22/Express│─►│ 16 managed │  │
│                         │        │  └───────┬────────┘  └────────────┘  │
│  recon-demo.vercel.app  │        │          │  private network, no      │
└─────────────────────────┘        │          │  public DB port           │
                                   └──────────┼───────────────────────────┘
                                              │ HTTPS, server-side only
                                              ▼
                                   ┌──────────────────────┐
                                   │  Gemini API          │
                                   │  3.5-flash · 3.7-flash│
                                   └──────────────────────┘
```

**The browser never talks to the LLM provider and never talks to Postgres.** Both of those are strictly server-side from the API service. That is the whole secrets story in one sentence.

## 2. Platform choices

| Component | Platform | Why |
|---|---|---|
| Frontend | **Vercel** | Next.js's first-party host. Push-to-deploy, automatic HTTPS, preview URLs per branch, zero config. Free tier is far beyond what a demo needs. |
| API | **Railway** | Deploys a Node service straight from the repo with no Dockerfile. Build/start commands are two text fields. |
| Database | **Railway PostgreSQL 16** | Provisioned inside the *same* project as the API, so `DATABASE_URL` is injected as a reference variable over the private network. No connection strings copied by hand, no public database port, no VPC configuration. **Pin the major version to 16 when provisioning** — see §2.1. |
| LLM | **Gemini API** (free tier, ADR-080) | Called only from the API service. |

**Why Railway over Render** (the closest alternative): Render is a fine fallback and would need no architectural change, but Railway's service-to-database variable referencing means the API's `DATABASE_URL` is never typed anywhere — it's a reference the platform resolves. One fewer secret in play, one fewer thing to leak. Recorded as ADR-026.

### 2.1 Postgres major version — pinned to 16, and validated against 16

The schema targets **PostgreSQL 16**, and the migrations are tested against a real
16.x server, not only against whatever a developer happens to have installed.

This is not pedantry. A local machine running 17 while production runs 16 is the
same class of problem as the audit trigger that installed cleanly and only failed
when exercised: the divergence is invisible until the environment that matters
behaves differently, and by then it is Day 13. "Nothing I used happens to be
version-specific" is a claim about code written by the same process that wrote the
code — it needs an independent check, and the check is cheap.

**What was actually done:** `apps/api/migrations/001`–`010` and the full invariant
suite in `tests/integration/migrations.test.ts` were run against `postgres:16`
(16.15) as well as a local 17. Both apply cleanly and all invariants fire
identically. Re-run it with:

```bash
docker run -d --name recon-pg16 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=recon16 -p 55416:5432 postgres:16
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55416/recon16 npm test --prefix apps/api
```

A stock `postgres:16` image used as a throwaway test fixture is **not** a
contradiction of ADR-005: that ADR rules out container orchestration and
authoring deployment containers, not using an off-the-shelf image as a local test
dependency. Nothing about the deploy topology changes.

**When provisioning on Railway**, pick Postgres 16 explicitly rather than
accepting the default, and record the actual server version in the Day 4 deploy
notes. If Railway only offers a newer major, that is fine — but then re-run the
suite against that major and update this section, rather than assuming forward
compatibility.

**Fallback plan** (worth having in advance rather than at 2am on Sept 4): if Railway's trial credit runs out before Sept 5, switch to Render — same two env vars, same build command, same Postgres URL shape. Budget 45 minutes.

---

## 3. Environment variables

### `apps/api` (Railway)

| Variable | Example | Required | Notes |
|---|---|---|---|
| `NODE_ENV` | `production` | yes | |
| `PORT` | `8080` | yes | Railway injects this. **Bind to `process.env.PORT`, never a hardcoded port** — the single most common first-deploy failure. |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | yes | Railway reference variable, not a literal. Requires `?sslmode=require` in production. |
| `GEMINI_API_KEY` | `AIza…` | no* | *Absent → explain layer degrades to templates, Phase A returns 503, and the run still completes (ADR-017, ADR-080). One key serves BOTH layers. |
| `GEMINI_EXPLAIN_MODEL` | `gemini-3.5-flash` | no | Defaults in code. Overridable without a deploy; a change invalidates `explanation_cache` by design (ADR-018). |
| `GEMINI_AGENT_MODEL` | `gemini-3.7-flash` | no | Defaults in code. Phase A only. |
| `AGENT_MAX_LLM_REQUESTS_PER_RUN` | `220` | no | **The bound that binds on a free-tier key** — there is no bill to cap and the scarce resource is requests per day (ADR-080). |
| `LLM_EXPLAIN_ENABLED` | `true` | no | Kill switch. Default `true`. |
| `LLM_MAX_CALLS_PER_RUN` | `8` | no | Hard cost cap per run (ADR-018). Default `8`. |
| `PROMPT_VERSION` | `v1` | no | Bumping it invalidates `explanation_cache`. Default `v1`. |
| `CORS_ORIGIN` | `https://recon-demo.vercel.app` | yes | **Exact origin, never `*`.** Comma-separated to add a preview URL. |
| `ALIAS_LEARNING_ENABLED` | `true` | no | Global default; per-run override via `configOverrides`. |
| `DEV_SEED` | `1337` | no | Dataset seed used during development (ADR-027). |
| `HOLDOUT_SEED` | `90210` | no | Seed for the reported/demo dataset. Never tuned against. |
| `LOG_LEVEL` | `info` | no | `debug` locally. |
| `RUN_MIGRATIONS_ON_BOOT` | `true` | no | Convenient at this scale; see §5.3 for the caveat. |
| `STALE_RUN_TIMEOUT_MINUTES` | `5` | no | **PARSED BUT NOT ENFORCED — `reapStaleRuns` is still a TODO in `index.ts`** (ADR-046, ADR-097). Intended: on boot, non-terminal runs older than this become `failed`. Until it lands, a crashed or restarted run polls forever mid-demo, which is why scale-to-zero stays off (ADR-097). |
| `CANDIDATE_CAP` | `200` | no | Per-record candidate cap (ADR-033). Cap hits are surfaced, never silent. |
| `BATCH_SUBSET_BUDGET_MS` | `2000` | no | Subset-sum safety valve, not the primary bound (ADR-060, amended by ADR-063). A lower value than the deterministic node budget's typical runtime would reintroduce the hardware-dependent split ADR-060 exists to eliminate. |
| `AGENT_ENABLED` | `true` | no | Master switch for Phase A. Off → the engine runs exactly as before. |
| `AGENT_MAX_INVESTIGATIONS_PER_RUN` | `20` | no | Triage cap (ADR-054). |
| `AGENT_MAX_COST_USD_PER_RUN` | `1.00` | no | Hard spend ceiling for Phase A. |
| `AGENT_QA_ENABLED` | `true` | no | Kill switch for the public Q&A box (ADR-056). Flippable without a deploy. |
| `AGENT_QA_MAX_QUESTIONS_PER_RUN` | `50` | no | Per-run Q&A ceiling. |
| `AGENT_QA_MAX_QUESTIONS_PER_HOUR` | `100` | no | Global token bucket across the deployment. |
| `AGENT_PROMPT_VERSION` | `agent-v1` | no | Separate from `PROMPT_VERSION`; the explain layer and the Analyst version independently. |
| `AGENT_MAX_COST_USD_PER_HOUR` | `2.00` | no | **The outer bound on the public investigate endpoint** (ADR-095). Derived from `cost_usd` rows already written, so it survives a restart. |
| `TRUST_PROXY_HOPS` | `1` | no | **Load-bearing on Railway** (ADR-096). At `0`, every visitor shares the edge's IP and therefore one rate-limit bucket — the first judge to browse locks out the rest. `1` reads the hop Railway's proxy wrote; `true`/leftmost would be client-forgeable. |
| `RATE_LIMIT_ENABLED` | `true` | no | ADR-096 kill switch. Turn off only to debug; the demo is unauthenticated and both meters (Anthropic, Railway) bill by usage. |

### `apps/web` (Vercel)

| Variable | Example | Required | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `https://recon-api.up.railway.app/api` | yes | Public by definition — it's a URL the browser calls. |

**That is the only frontend variable, and it is deliberately the only one.** Anything prefixed `NEXT_PUBLIC_` is compiled into the JavaScript bundle and is readable by anyone who opens devtools. If a secret ever needs to reach the frontend, the design is wrong.

---

## 4. Handling the LLM API key

The rule, stated plainly: **`GEMINI_API_KEY` exists in exactly two places — the Railway dashboard, and the developer's local `.env` file, which is gitignored. Nowhere else, ever.**

**Concretely:**

1. `.env` is in `.gitignore` from the first commit, before any key exists to leak.
2. `.env.example` **is** committed, with every variable name and empty values, so a future session knows what's needed without knowing any value:
   ```
   DATABASE_URL=
   GEMINI_API_KEY=
   CORS_ORIGIN=http://localhost:3000
   ```
3. In production the value is set only through Railway's variables UI. It is never in the repo, never in a build arg, never in `vercel.json`, never in a commit message, never pasted into a chat or a doc.
4. All Gemini calls originate in `apps/api`. There is **no** proxy route that forwards a client-supplied key, and no endpoint accepts a key in a request body or header.
5. The key is never logged. The Gemini client is constructed once at startup; log lines reference `GEMINI_EXPLAIN_MODEL` / `GEMINI_AGENT_MODEL`, never the key, and error handlers must not dump the client's config object.
6. `GET /api/health` reports `llmConfigured: true|false` — a **boolean**, never a prefix, never a masked fragment. Enough to debug a deploy, useless to an attacker.
7. **If a key is ever committed:** rotate it in Google AI Studio first, then worry about git history. Rewriting history without rotating is theatre — the key is already public.

**Cost containment** is part of secrets hygiene here, because an exposed-or-not key with an unbounded loop behind it is the actual financial risk: `LLM_MAX_CALLS_PER_RUN` caps calls per run (ADR-018), the signature cache makes repeat runs nearly free, and `AGENT_MAX_COST_USD_PER_RUN` bounds Phase A. **Since ADR-056 there *is* a user-facing "ask the AI" box** (endpoint 28), so an anonymous visitor can spend tokens — which matters, because the app has no auth (ARCHITECTURE §5). That path is bounded by the Q&A quotas below rather than by its absence.

> **Corrected 2026-08-26 (ADR-056).** This section previously claimed *"there is no user-facing 'ask the AI' box, so there is no path for an anonymous visitor to burn quota."* **That is no longer true.** `POST /api/runs/:runId/ask` (endpoint 28) is exactly such a box, on a public URL with no auth. Leaving the old claim in place while shipping the thing that breaks it would be precisely the quiet dishonesty this project is built to avoid, so it is corrected here rather than quietly dropped.
>
> **The exposure, stated plainly:** an anonymous visitor can spend the project's LLM quota by asking questions. **On a free-tier key that is worse than a bill, not better** — the ceiling is a daily request quota, and exhausting it kills the demo for everyone until it resets, with no way to pay to reopen it (ADR-080). **The mitigations:** `AGENT_QA_MAX_QUESTIONS_PER_RUN` (50), `AGENT_QA_MAX_QUESTIONS_PER_HOUR` (100, global), 6 steps and 1024 output tokens per question, `AGENT_MAX_LLM_REQUESTS_PER_RUN` (220) bounding Phase A, `AGENT_MAX_COST_USD_PER_RUN` still tracked for a billed key, and `AGENT_QA_ENABLED` as a kill switch flippable without a deploy. Questions and their request counts are logged, so abuse is visible while it is happening rather than inferred from a bill at month end.
>
> **Flagged, not decided:** adding auth to close this properly remains explicitly out of scope. If it becomes a real concern before submission, the cheap answer is a shared-secret header on `POST /api/runs` and `POST /api/runs/:runId/ask` only — **noted as an option, not adopted**, since it complicates the panel's ability to click around. The kill switch is the answer if quota becomes a live problem during judging.

---

## 5. Deploy steps

### 5.1 One-time setup (target: Day 11 for the API, Day 12 for the web — ADR-061, ~40 minutes)

**Railway — API + database**
1. New project → **Deploy from GitHub repo**, select this repo.
2. Add a **PostgreSQL** service to the same project.
3. On the API service, set the root directory to `apps/api`, build command to `npm ci && npm run build`, start command to `npm run start`.
4. Add the variables from §3. Set `DATABASE_URL` as the reference `${{Postgres.DATABASE_URL}}`.
5. Generate a public domain for the API service. Note the URL.
6. Deploy. Verify:
   ```bash
   curl -s https://recon-api.up.railway.app/api/health
   ```
   Expect `{"status":"ok","dbConnected":true,"llmConfigured":true,...}`.

**Vercel — frontend**
1. Import the same repo, set the root directory to `apps/web`. Framework preset: Next.js.
2. Set `NEXT_PUBLIC_API_BASE_URL` to the Railway API URL + `/api`.
3. Deploy. Note the assigned domain.

**Close the loop**
4. Set `CORS_ORIGIN` on Railway to the exact Vercel domain and redeploy the API. *(Chicken-and-egg is unavoidable — the frontend URL doesn't exist until step 3. Expect exactly one CORS failure between steps 3 and 4; it is not a bug.)*

### 5.2 Seed the demo data (same day)

The public demo must show a completed run the instant a panelist opens it — never an empty state with an upload form.

1. Run the generator locally against `HOLDOUT_SEED` to produce the three source files plus the answer key.
2. Commit the three source files to `data/fixtures/holdout/` so the deployed API can seed itself. Commit the answer key to `data/truth/` (ADR-021 — separate directory, never read by the engine).
3. Trigger one run against the deployed API:
   ```bash
   curl -X POST https://recon-api.up.railway.app/api/runs -H 'Content-Type: application/json' -d '{"useSeedDataset":true,"datasetSeed":90210,"label":"demo-holdout"}'
   ```
4. Confirm the dashboard loads it as the default run.

### 5.3 Ongoing deploys

**Railway redeploys are MANUAL — one click in the dashboard, on demand.** This paragraph
used to claim both platforms rebuilt automatically on a push to `main`. That contradicted
**ADR-074**, which is the locked decision and says the opposite: *"redeployment stays a
single manual action, and there is no CI/CD."* The deployment follows ADR-074. The claim
here was aspirational and was never true of the setup.

**Manual is the right default until after submission (ADR-097's reasoning applies):**
there is no CI, so nothing sits between `git push` and production; the frontend build
means frequent pushes to `main`; and a restart mid-run has no reaper to clean up after it,
so an interrupted run polls forever. Auto-deploy would turn that from rare into routine.

Enable Railway's GitHub auto-deploy **after** the 2026-09-05 submission, and preferably
after `reapStaleRuns` lands. Vercel's push-to-deploy is a separate question and is fine
for a static frontend, which has no in-flight work to lose.

**Migrations** run on API boot when `RUN_MIGRATIONS_ON_BOOT=true`. Acceptable here because there is exactly one API instance and no rolling deploy — with multiple replicas this races and would need a separate release step. **Noted so a future session doesn't copy this pattern into somewhere it's wrong.** Migrations are forward-only numbered files; a bad migration is fixed by a new migration, never by editing a shipped one.

### 5.4 Pre-submission checklist (Day 13)

- [ ] `/api/health` returns `dbConnected: true` and `llmConfigured: true` (provider-aware since Day 15 — it reads the key belonging to `LLM_PROVIDER`, not always Gemini)
- [ ] `TRUST_PROXY_HOPS=1` is set, and two different clients get independent rate-limit budgets (ADR-096)
- [ ] Production Postgres major version matches the one the migrations were validated against (§2.1)
- [ ] Dashboard loads the demo run with no interaction
- [ ] Match rate, **false-positive count**, and cold-start rate all visible on the landing screen (ADR-020)
- [ ] Exception list renders with explanations populated
- [ ] Audit drill-down works for at least one alias-tier match
- [ ] `GET /api/runs/:runId/audit/verify` returns `valid: true` on the demo run (ADR-042)
- [ ] A score report exists for the demo run, so the dashboard shows **measured** accuracy rather than "not measured" (ADR-041)
- [ ] The scale-benchmark table is committed and linked from the README (ADR-045)
- [ ] Phase A has run on the demo run: investigations visible, at least one `RESOLUTION_PROPOSED` and one `CONFIRMED_UNRESOLVABLE` on screen
- [ ] **Hallucinated resolutions is 0** on the holdout run (ADR-053 — build blocker, verify before recording the video)
- [ ] Q&A box answers a seeded question with a working citation link, and the rate limiter returns `429` when exercised
- [ ] Excluded / rejected / duplicate row counts are visible via endpoint 24 — the denominator is inspectable
- [ ] Alias management screen shows the seeded aliases and their lineage
- [ ] CORS works from the production Vercel domain (test in a private window, not a warm tab)
- [ ] No secret in `git log -p`, in the Vercel bundle, or in any committed `.env`
- [ ] README links the live demo URL above the fold

---

## 6. What is deliberately absent

| Not doing | Why |
|---|---|
| Kubernetes / Docker Compose / ECS | ADR-005. Zero rubric points; parked as a separate learning project. |
| Custom domain | A `.vercel.app` URL is fine for a panel. |
| Staging environment | Vercel preview deploys cover the frontend; the API has one environment on purpose. |
| CI/CD pipeline beyond push-to-deploy | Both platforms build on push. A GitHub Action adds config to maintain and catches nothing at solo scale. |
| Monitoring / APM / error tracking | Platform logs suffice for a 13-day demo. **Flagged as scope creep.** |
| DB backups | The data is synthetic and regenerable from a seed. Regeneration *is* the backup. |
| Job queue / worker process | Runs execute in-process after a `202` (ADR-024). The stale-run reaper (ADR-046) covers the one failure mode this creates. A queue would be infrastructure for a workload that finishes in seconds. |
| Rate limiting / WAF | See the flagged note in §4. |
| Autoscaling | One instance, a few hundred records. |
