import { listRuns } from '@/lib/api-client';
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

export async function resolveRun(requested: string | undefined): Promise<RunContext | null> {
  const { runs } = await listRuns();
  if (runs.length === 0) return null;

  const asked = requested ? runs.find((r) => r.runId === requested) : undefined;
  const run = asked ?? runs.find((r) => r.status === 'completed') ?? runs[0];
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
