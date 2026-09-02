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
}

/**
 * WAS SILENTLY WRONG THE MOMENT A 26TH RUN EXISTED (found live, 2026-09-03).
 *
 * `listRuns()` is a PAGINATED CONVENIENCE LIST — its default page holds the
 * 25 most recent runs, nothing more. This function used to look for the
 * requested run ONLY inside that page: `runs.find((r) => r.runId ===
 * requested)`. The moment a 26th run existed, any older run named by an
 * explicit `?run=` — a bookmarked link, a memorized URL for a demo — fell
 * off page 1, `find` returned `undefined`, and the function fell back to
 * "most recently completed" with NO error, no banner, nothing on screen to
 * say the requested run had been swapped out. A reader would see a
 * different run's numbers with full confidence they were the ones asked
 * for. `verify`, the one run this project's own rehearsal notes name for a
 * live alias-teaching demo, was the run that fell off — silently replaced
 * by a demo-dataset run with a different queue, different counterparties,
 * different everything.
 *
 * Fixed by treating `listRuns()` as what it is — a list for browsing, not
 * a lookup table — and asking for a SPECIFIC id the way `getRun` (endpoint
 * 4) exists to answer: directly, unaffected by how many runs exist. The
 * default-selection fallback (newest completed) is unchanged; it now only
 * fires when nothing was explicitly requested, or when the id genuinely
 * does not exist.
 */
export async function resolveRun(requested: string | undefined): Promise<RunContext | null> {
  const { runs } = await listRuns();
  if (runs.length === 0) return null;

  if (requested) {
    const asked = runs.find((r) => r.runId === requested);
    if (asked) return { run: asked, runs };

    // Not on the default page. Ask for it directly rather than concluding
    // it does not exist — `runs` is a recency-ordered sample, not the truth
    // about which ids are valid.
    try {
      const run = await getRun(requested);
      return { run, runs };
    } catch (err) {
      // A GENUINE 404 (or the API being unreachable for this one call)
      // falls through to the same default this function has always used.
      // `runs` is never re-fetched here — a second `listRuns()` call would
      // not change which ids are on page 1.
      if (!(err instanceof ApiClientError)) throw err;
    }
  }

  const run = runs.find((r) => r.status === 'completed') ?? runs[0];
  return run ? { run, runs } : null;
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
