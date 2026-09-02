/**
 * Score every completed run that has not been scored yet, then keep watching.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE PROCESS AND NOT A BUTTON IN THE APP.
 *
 * The obvious fix for "no score report exists for this run" is a **Measure**
 * button on the dashboard. It cannot exist: **ADR-021** forbids any module
 * under `apps/api` from reading `data/truth/`, and a leak guard enforces it by
 * grep. That rule is not bureaucracy — it is the reason the accuracy claim is
 * believable at all. "Does any code path reach the answer key?" is a question
 * you would otherwise have to *audit*; keeping the key outside the application
 * makes leak-freedom obvious in five seconds.
 *
 * So the measurement stays outside the wall and arrives the way the contract
 * always intended: `POST /api/runs/:runId/score-report` (endpoint 23) exists
 * precisely so an offline scorer can push a result in. This watcher is that
 * scorer, run on a loop instead of by hand.
 * ---------------------------------------------------------------------------
 *
 * Judges never see `npm run score` in the interface, and a run started from the
 * dashboard is measured within a few seconds of completing — without the engine
 * ever being able to see the answers.
 *
 *   npm run score:watch [-- --api http://localhost:8080 --interval 5]
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main as scoreOnce } from './index.js';

const TRUTH = fileURLToPath(new URL('../../data/truth/', import.meta.url));

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
};

const api = arg('api', 'http://localhost:8080');
const intervalSec = Number(arg('interval', '5'));
const once = process.argv.includes('--once');

/**
 * The answer key for a seed, found by filename rather than by a hardcoded map —
 * the generator writes `<label>_seed_<seed>.json`, so the mapping is already
 * expressed on disk and a second copy here would eventually disagree with it.
 */
function keyFor(seed: number | null): string | null {
  if (seed === null) return null;
  const hit = readdirSync(TRUTH).find((f) => f.endsWith(`_seed_${seed}.json`));
  return hit === undefined ? null : TRUTH + hit;
}

interface RunRow { runId: string; label: string; status: string; datasetSeed: number | null }

async function unscored(): Promise<RunRow[]> {
  const res = await fetch(`${api}/api/runs?pageSize=100`);
  if (!res.ok) throw new Error(`GET /api/runs → ${res.status}`);
  const { runs } = await res.json() as { runs: RunRow[] };

  const out: RunRow[] = [];
  for (const r of runs) {
    if (r.status !== 'completed') continue;
    const m = await fetch(`${api}/api/runs/${r.runId}/metrics`);
    if (!m.ok) continue;
    const { measured } = await m.json() as { measured: unknown };
    if (measured === null) out.push(r);
  }
  return out;
}

async function pass(): Promise<void> {
  let pending: RunRow[];
  try {
    pending = await unscored();
  } catch (err) {
    console.error(`[score:watch] ${(err as Error).message}`);
    return;
  }
  for (const r of pending) {
    const key = keyFor(r.datasetSeed);
    if (key === null) {
      // A run whose dataset has no committed key cannot be measured, and
      // saying so beats retrying it every five seconds forever.
      console.log(`[score:watch] ${r.label}: no answer key for seed ${r.datasetSeed} — skipped`);
      continue;
    }
    const code = await scoreOnce(['--run', r.runId, '--api', api, '--key', key, '--post'])
      .catch((err: unknown) => { console.error(`[score:watch] ${r.label}:`, err); return 1; });
    console.log(`[score:watch] ${r.label} → exit ${code}`);
  }
}

await pass();
if (!once) {
  console.log(`[score:watch] watching ${api}, every ${intervalSec}s. Ctrl-C to stop.`);
  setInterval(() => { void pass(); }, intervalSec * 1000);
}
