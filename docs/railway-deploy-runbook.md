# Railway deploy — step by step

Companion to [`deployment.md`](./deployment.md) §5, which owns the *decisions*. This owns the
*keystrokes*. Written 2026-09-02 against `main` at `a28190c`.

**Time: ~40 minutes.** ADR-074: the point is to flush unknowns while there is still time to absorb
them, not to be finished. **Acceptance is "a second deploy is one command", not "it is live".**

---

## ⚠ Read this first — it will bite you otherwise

**Set Railway's Root Directory to the REPOSITORY ROOT, not `apps/api`.**

`app.ts:25` resolves the demo fixtures as `../../../data/fixtures/holdout/` from the compiled
`apps/api/dist/app.js` — i.e. the repo root. If you point Railway at `apps/api`, `data/` is outside
the build context, the seeded-dataset path (`POST /api/runs` variant B — **the demo path**) fails at
runtime with a missing-file error, and nothing catches it until you click.

There are no npm workspaces (ADR-058: three independent packages), so you must give the build and
start commands the `cd` yourself. Details in step 3.

---

## 1. Create the project and the database (~5 min)

1. https://railway.app → sign in with GitHub.
2. **New Project** → **Deploy from GitHub repo** → `flare19/payment-reconciliation-agent-platform`.
3. In the project canvas: **+ New** → **Database** → **Add PostgreSQL**.
4. Click the Postgres service → **Variables** → confirm `DATABASE_URL` exists. Do not copy it
   anywhere; you will reference it, not paste it.

> **Postgres version.** `deployment.md` §2.1 pins **16**, and migrations were validated against 16
> *and* 17, so a Railway default of 17 is safe. If Railway offers a choice, take 16.

---

## 2. Point the service at the right code (~5 min)

Select the **API service** (not the database) → **Settings**:

| Field | Value |
|---|---|
| Root Directory | *(leave EMPTY — repository root)* |
| Build Command | `cd apps/api && npm ci && npm run build` |
| Start Command | `cd apps/api && npm start` |

`npm start` is `node dist/index.js`. Node ≥22 is declared in `apps/api/package.json` `engines`, which
Nixpacks reads — you should not need to pin a Node version by hand.

---

## 3. Variables (~10 min)

API service → **Variables**. `DATABASE_URL` and `CORS_ORIGIN` are the only two the app *refuses to
boot without* (`required()` in `config/env.ts`); everything else has a default.

```
DATABASE_URL=${{Postgres.DATABASE_URL}}      ← reference, not a paste
CORS_ORIGIN=http://localhost:3000            ← replace with the Vercel URL after U19
NODE_ENV=production
RUN_MIGRATIONS_ON_BOOT=true

LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=<paste>                    ← the ONLY secret here
LLM_AGENT_MODEL=claude-sonnet-5
LLM_EXPLAIN_MODEL=claude-sonnet-5
AGENT_EFFORT=low

AGENT_MAX_COST_USD_PER_HOUR=2.0              ← ADR-095. The one an anonymous visitor cannot reset
AGENT_MAX_COST_USD_PER_RUN=1.20
AGENT_MAX_INVESTIGATIONS_PER_RUN=10
AGENT_MAX_QUEUE_TRIAGES_PER_RUN=5
LLM_MAX_CALLS_PER_RUN=6
```

**Do NOT set `PORT`.** Railway injects it; `config/env.ts:147` reads it and defaults to 8080 only
locally. Hardcoding a port is `deployment.md` §3's named most-common first-deploy failure.

**TLS is already handled** — `db/pool.ts:58` uses `{ rejectUnauthorized: false }` for any non-local
`DATABASE_URL`, because Railway's managed Postgres requires TLS and presents a chain Node will not
verify by default. Nothing to configure.

---

## 4. Deploy and check (~10 min)

Railway builds on save. When it goes green:

```bash
curl https://<your-app>.up.railway.app/api/health
```

Expect: `{"status":"ok","dbConnected":true,"llmConfigured":true,"version":"1.0.0"}`

- `dbConnected: false` → `DATABASE_URL` reference is wrong, or migrate-on-boot threw. Check
  **Deploy Logs**.
- `llmConfigured: false` → `ANTHROPIC_API_KEY` is unset or `LLM_PROVIDER` is not `anthropic`.
  Both surfaces follow one switch (ADR-093), so this is one boolean for the whole system.

Then confirm the migrations actually ran:

```bash
curl https://<your-app>.up.railway.app/api/runs      # expect [] — an empty list, not a 500
```

---

## 5. Seed the demo data (~5 min)

The fixtures ship in the repo, so no upload is needed — this is why step 2's Root Directory matters.

```bash
curl -X POST https://<your-app>.up.railway.app/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"label":"demo","datasetSeed":90210}'
```

Poll until `status: "completed"`, then check the headline:

```bash
curl https://<your-app>.up.railway.app/api/runs/<runId>
```

**It must read 284 matches, 212 exceptions, matchRatePct 65.22.** Anything else means the deployed
engine is not the local one, and that is a stop-and-investigate, not a rounding difference.

> **Explain will call Anthropic on this run** (~$0.03) and generate 21 signatures. That is expected
> and it is the cheap surface. `AGENT_MAX_COST_USD_PER_HOUR` does not gate S13 — `LLM_MAX_CALLS_PER_RUN=6`
> does.

---

## 6. Prove the acceptance criterion (~5 min)

ADR-074's bar is **"a second deploy is one command"**, so do one:

```bash
git commit --allow-empty -m "Redeploy check" && git push
```

Railway should rebuild and redeploy with no console interaction. If it does not, fix that now —
that, not the first deploy, is the thing being tested.

---

## When it breaks

**Build fails, "cannot find module":** Root Directory is set to `apps/api`. Clear it (step 2).

**Runtime ENOENT on `data/fixtures/holdout/...`:** same cause, seen at click time instead of build
time. Root Directory must be the repository root.

**Boot loop with no error:** `CORS_ORIGIN` is unset. It is `required()` and its absence throws before
the server listens, so Deploy Logs show a crash with no request ever arriving.

**`llmConfigured: true` but explanations are all templates:** `LLM_EXPLAIN_ENABLED` is false, or
`LLM_MAX_CALLS_PER_RUN` is 0. Check `runs.metrics.llmCost.signaturesTemplated`.

**429 `AGENT_QUOTA_EXCEEDED` while testing:** working as designed (ADR-095). The trailing-hour
ceiling is `$2`. Raise `AGENT_MAX_COST_USD_PER_HOUR` deliberately, or wait for older spend to leave
the window.

---

## What is NOT part of this

No CI/CD, by decision (ADR-074, ADR-005): one person, one branch, two `npm test` commands and a
review gate that already exists. No containers we author. No Kubernetes (ADR-005). Redeployment is a
`git push`, and that is the whole pipeline.

After this: **`CORS_ORIGIN` must be updated to the Vercel URL** once U19 lands, or the browser will
block every request from the deployed frontend.
