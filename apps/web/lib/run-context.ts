import { ApiClientError, getRun, listRuns } from '@/lib/api-client';
import type { RunSummary } from '@/types/api';

/**
 * Which run is every screen looking at?
 *
 * Six screens all need the answer and all resolve it the same way: an explicit
 * `?run=` if it names a run that exists, otherwise the most recent COMPLETED
 * run. Completed beats merely-recent because the newest run may be one somebody
 * started thirty seconds ago, and a screen whose job is to show a result should
 * not open on a progress bar.
 *
 * Kept in one place so a link carrying `?run=` from any screen lands on the
 * same run on every other screen. Two screens disagreeing about which run they
 * are describing is the kind of bug that is invisible until someone compares
 * two numbers across tabs and finds they do not add up.
 */
export interface RunContext {
  run: RunSummary;
  runs: RunSummary[];
  /**
   * The TRUE total, from `pagination.total` — not `runs.length`. `runs` is
   * capped at `RUN_LIST_FETCH_SIZE`; a screen that reports "all N runs" using
   * `runs.length` instead of this is making the same false-completeness claim
   * "Show all" made before this field existed (found live, 2026-09-03: it
   * read "All 25 runs" with 31 in the database).
   */
  runsTotal: number;
  /**
   * The run a screen shows when nothing is explicitly asked for — the pinned
   * demo run if `PINNED_RUN_ID` names one that exists and completed, otherwise
   * the newest completed run (ADR-166).
   *
   * Resolved ONCE, here, and carried on the context. Eight screens used to
   * recompute `runs.find(completed) ?? runs[0]` inline to decide whether to
   * thread `?run=` into their links; that is the same private-copy shape as
   * ADR-157's bug, and with a pinned run it would have gone wrong on all eight
   * at once. `run.runId === defaultRunId` is the one check they all share now.
   */
  defaultRunId: string;
}

/**
 * The run the dashboard opens on when nothing is requested (ADR-166).
 *
 * A throwaway probe run at 26.89% silently became the site's headline during a
 * judge review because the landing page follows the newest completed run. On
 * panel day one stray click should not put a crippled run on the front page, so
 * a canonical run is pinned by id and everything else — the run picker, every
 * `?run=` link — keeps working exactly as before.
 *
 * Server-only (no `NEXT_PUBLIC_`): it is read here, in a server module, and has
 * no business in the client bundle. Unset in local dev, set on the deployed web.
 */
const PINNED_RUN_ID = process.env['PINNED_RUN_ID']?.trim() || undefined;

/**
 * WAS SILENTLY WRONG THE MOMENT A 26TH RUN EXISTED (found live, 2026-09-03).
 *
 * `listRuns()` is a PAGINATED CONVENIENCE LIST. This function used to look
 * for the requested run ONLY inside its default page (then 25 rows): `runs
 * .find((r) => r.runId === requested)`. The moment a 26th run existed, any
 * older run named by an explicit `?run=` — a bookmarked link, a memorized
 * URL for a demo — fell off the page, `find` returned `undefined`, and the
 * function fell back to "most recently completed" with NO error, no banner,
 * nothing on screen to say the requested run had been swapped out. A reader
 * would see a different run's numbers with full confidence they were the
 * ones asked for. `verify`, the one run this project's own rehearsal notes
 * name for a live alias-teaching demo, was the run that fell off — silently
 * replaced by a demo-dataset run with a different queue, different
 * counterparties, different everything.
 *
 * Fixed by treating `listRuns()` as what it is — a list for browsing, not
 * a lookup table — and asking for a SPECIFIC id the way `getRun` (endpoint
 * 4) exists to answer: directly, unaffected by how many runs exist. The
 * default-selection fallback (newest completed) is unchanged; it now only
 * fires when nothing was explicitly requested, or when the id genuinely
 * does not exist.
 *
 * RUN_LIST_FETCH_SIZE IS `MAX_PAGE_SIZE`, THE API'S OWN CEILING (found live,
 * 2026-09-03) — not a second guess at how many runs might exist. The
 * dashboard's "Show all" reused this same `runs` array and, with the old
 * 25-row default, said "All 25 runs" while 31 existed: a false completeness
 * claim, on the one screen whose entire design exists to never make one.
 * `runsTotal` (from `pagination.total`, not `runs.length`) lets a caller
 * state the true count even in the run this ceiling itself is eventually
 * exceeded by — the honest failure mode is "showing 200 of 340", never a
 * silent "All".
 */
const RUN_LIST_FETCH_SIZE = 200;

/**
 * The default (nothing-requested) run: the pinned one if it exists and
 * completed, otherwise newest completed, otherwise the newest run at all.
 *
 * A pinned id that names nothing, or a run that has not finished, is NOT an
 * error a visitor should see — it falls back to the newest completed run and
 * logs once on the server. The point of pinning is stability on panel day; a
 * broken pin should degrade to today's behaviour, not to a blank page.
 */
async function resolveDefaultRun(runs: RunSummary[]): Promise<RunSummary> {
  const newestCompleted = runs.find((r) => r.status === 'completed') ?? runs[0]!;

  if (!PINNED_RUN_ID) return newestCompleted;

  const onPage = runs.find((r) => r.runId === PINNED_RUN_ID);
  const pinned = onPage ?? await getRun(PINNED_RUN_ID).catch((err) => {
    if (err instanceof ApiClientError) return null;
    throw err;
  });

  if (pinned && pinned.status === 'completed') return pinned;

  console.warn(
    `[run-context] PINNED_RUN_ID=${PINNED_RUN_ID} ${pinned ? `is ${pinned.status}, not completed` : 'does not exist'}; `
    + 'falling back to the newest completed run.');
  return newestCompleted;
}

export async function resolveRun(requested: string | undefined): Promise<RunContext | null> {
  const { runs, pagination } = await listRuns(RUN_LIST_FETCH_SIZE);
  if (runs.length === 0) return null;
  const runsTotal = pagination.total;

  const defaultRun = await resolveDefaultRun(runs);
  const defaultRunId = defaultRun.runId;

  if (requested) {
    const asked = runs.find((r) => r.runId === requested);
    if (asked) return { run: asked, runs, runsTotal, defaultRunId };

    // Not on the fetched page. Ask for it directly rather than concluding
    // it does not exist — `runs` is a recency-ordered sample, not the truth
    // about which ids are valid.
    try {
      const run = await getRun(requested);
      return { run, runs, runsTotal, defaultRunId };
    } catch (err) {
      // A GENUINE 404 (or the API being unreachable for this one call)
      // falls through to the same default this function has always used.
      // `runs` is never re-fetched here — a second `listRuns()` call would
      // not change which ids are on the fetched page.
      if (!(err instanceof ApiClientError)) throw err;
    }
  }

  return { run: defaultRun, runs, runsTotal, defaultRunId };
}

/** Reads `?run=` out of Next's resolved search params. */
export const runParam = (params: Record<string, string | string[] | undefined>) =>
  (typeof params['run'] === 'string' ? params['run'] : undefined);

/** Reads any single-valued query param, treating a repeated one as absent. */
export const one = (
  params: Record<string, string | string[] | undefined>, key: string,
): string | undefined => (typeof params[key] === 'string' ? params[key] : undefined);

/**
 * Carries the run across links so `?run=` survives navigation.
 *
 * Omits the run entirely when it is the default one, so the common case has
 * clean URLs and a shared link is not pinned to a run that will not be the
 * newest by the time somebody opens it.
 */
export function hrefWith(
  base: string,
  params: Record<string, string | number | undefined>,
): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== null) s.set(k, String(v));
  }
  const q = s.toString();
  return q ? `${base}?${q}` : base;
}
