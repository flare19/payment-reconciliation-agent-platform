# Deployment

Payment Reconciliation Engine · Razorpay AI Buildathon Track 4
Status: **Locked.** Deployed early on purpose, not on Day 12. Revised by the Day 4 design review (ADR-046).
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
                                   │  Anthropic API       │
                                   │  claude-sonnet-5     │
                                   └──────────────────────┘
```

**The browser never talks to Anthropic and never talks to Postgres.** Both of those are strictly server-side from the API service. That is the whole secrets story in one sentence.

## 2. Platform choices

| Component | Platform | Why |
|---|---|---|
| Frontend | **Vercel** | Next.js's first-party host. Push-to-deploy, automatic HTTPS, preview URLs per branch, zero config. Free tier is far beyond what a demo needs. |
| API | **Railway** | Deploys a Node service straight from the repo with no Dockerfile. Build/start commands are two text fields. |
| Database | **Railway PostgreSQL** | Provisioned inside the *same* project as the API, so `DATABASE_URL` is injected as a reference variable over the private network. No connection strings copied by hand, no public database port, no VPC configuration. |
| LLM | **Anthropic API** | Called only from the API service. |

**Why Railway over Render** (the closest alternative): Render is a fine fallback and would need no architectural change, but Railway's service-to-database variable referencing means the API's `DATABASE_URL` is never typed anywhere — it's a reference the platform resolves. One fewer secret in play, one fewer thing to leak. Recorded as ADR-026.

**Fallback plan** (worth having in advance rather than at 2am on Sept 4): if Railway's trial credit runs out before Sept 5, switch to Render — same two env vars, same build command, same Postgres URL shape. Budget 45 minutes.

---

## 3. Environment variables

### `apps/api` (Railway)

| Variable | Example | Required | Notes |
|---|---|---|---|
| `NODE_ENV` | `production` | yes | |
| `PORT` | `8080` | yes | Railway injects this. **Bind to `process.env.PORT`, never a hardcoded port** — the single most common first-deploy failure. |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | yes | Railway reference variable, not a literal. Requires `?sslmode=require` in production. |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | no* | *Absent → explain layer degrades to templates and the run still completes (ADR-017). |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | no | Defaults in code. Overridable without a deploy. |
| `LLM_EXPLAIN_ENABLED` | `true` | no | Kill switch. Default `true`. |
| `LLM_MAX_CALLS_PER_RUN` | `8` | no | Hard cost cap per run (ADR-018). Default `8`. |
| `PROMPT_VERSION` | `v1` | no | Bumping it invalidates `explanation_cache`. Default `v1`. |
| `CORS_ORIGIN` | `https://recon-demo.vercel.app` | yes | **Exact origin, never `*`.** Comma-separated to add a preview URL. |
| `ALIAS_LEARNING_ENABLED` | `true` | no | Global default; per-run override via `configOverrides`. |
| `DEV_SEED` | `1337` | no | Dataset seed used during development (ADR-027). |
| `HOLDOUT_SEED` | `90210` | no | Seed for the reported/demo dataset. Never tuned against. |
| `LOG_LEVEL` | `info` | no | `debug` locally. |
| `RUN_MIGRATIONS_ON_BOOT` | `true` | no | Convenient at this scale; see §5.3 for the caveat. |
| `STALE_RUN_TIMEOUT_MINUTES` | `5` | no | On boot, non-terminal runs older than this are marked `failed` (ADR-046). Without it a crashed run polls forever mid-demo. |
| `CANDIDATE_CAP` | `200` | no | Per-record candidate cap (ADR-033). Cap hits are surfaced, never silent. |
| `BATCH_SUBSET_BUDGET_MS` | `250` | no | Subset-sum time budget per batch (ADR-038). |

### `apps/web` (Vercel)

| Variable | Example | Required | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `https://recon-api.up.railway.app/api` | yes | Public by definition — it's a URL the browser calls. |

**That is the only frontend variable, and it is deliberately the only one.** Anything prefixed `NEXT_PUBLIC_` is compiled into the JavaScript bundle and is readable by anyone who opens devtools. If a secret ever needs to reach the frontend, the design is wrong.

---

## 4. Handling the LLM API key

The rule, stated plainly: **`ANTHROPIC_API_KEY` exists in exactly two places — the Railway dashboard, and the developer's local `.env` file, which is gitignored. Nowhere else, ever.**

**Concretely:**

1. `.env` is in `.gitignore` from the first commit, before any key exists to leak.
2. `.env.example` **is** committed, with every variable name and empty values, so a future session knows what's needed without knowing any value:
   ```
   DATABASE_URL=
   ANTHROPIC_API_KEY=
   CORS_ORIGIN=http://localhost:3000
   ```
3. In production the value is set only through Railway's variables UI. It is never in the repo, never in a build arg, never in `vercel.json`, never in a commit message, never pasted into a chat or a doc.
4. All Anthropic calls originate in `apps/api`. There is **no** proxy route that forwards a client-supplied key, and no endpoint accepts a key in a request body or header.
5. The key is never logged. The Anthropic client is constructed once at startup; log lines reference `ANTHROPIC_MODEL`, never the key, and error handlers must not dump the client's config object.
6. `GET /api/health` reports `llmConfigured: true|false` — a **boolean**, never a prefix, never a masked fragment. Enough to debug a deploy, useless to an attacker.
7. **If a key is ever committed:** rotate it in the Anthropic console first, then worry about git history. Rewriting history without rotating is theatre — the key is already public.

**Cost containment** is part of secrets hygiene here, because an exposed-or-not key with an unbounded loop behind it is the actual financial risk: `LLM_MAX_CALLS_PER_RUN` caps calls per run (ADR-018), the signature cache makes repeat runs nearly free, and no endpoint triggers LLM work except a reconciliation run. There is no user-facing "ask the AI" box, so there is no path for an anonymous visitor to burn quota — which matters, because the app has no auth (ARCHITECTURE §5).

> **Flagged, not decided:** the deployed demo is a public URL with no auth. Anyone with the link can trigger a run. Mitigations in place are the per-run call cap and the absence of any free-form LLM endpoint. Adding auth to close this properly is explicitly out of scope. If it becomes a real concern before submission, the cheap answer is a single shared-secret header on `POST /api/runs` only — **noted as an option, not adopted**, since it complicates the panel's ability to click around.

---

## 5. Deploy steps

### 5.1 One-time setup (target: Day 3, ~40 minutes)

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

Push to `main` → both platforms rebuild automatically. No manual step.

**Migrations** run on API boot when `RUN_MIGRATIONS_ON_BOOT=true`. Acceptable here because there is exactly one API instance and no rolling deploy — with multiple replicas this races and would need a separate release step. **Noted so a future session doesn't copy this pattern into somewhere it's wrong.** Migrations are forward-only numbered files; a bad migration is fixed by a new migration, never by editing a shipped one.

### 5.4 Pre-submission checklist (Day 12)

- [ ] `/api/health` returns `dbConnected: true` and `llmConfigured: true`
- [ ] Dashboard loads the demo run with no interaction
- [ ] Match rate, **false-positive count**, and cold-start rate all visible on the landing screen (ADR-020)
- [ ] Exception list renders with explanations populated
- [ ] Audit drill-down works for at least one alias-tier match
- [ ] `GET /api/runs/:runId/audit/verify` returns `valid: true` on the demo run (ADR-042)
- [ ] A score report exists for the demo run, so the dashboard shows **measured** accuracy rather than "not measured" (ADR-041)
- [ ] The scale-benchmark table is committed and linked from the README (ADR-045)
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
