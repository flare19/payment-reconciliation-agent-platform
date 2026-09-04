/**
 * THE ONE PLACE THAT DECIDES WHICH DATABASE THE INTEGRATION SUITE MAY DESTROY.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * EVERY FILE IN THIS DIRECTORY OPENS WITH `TRUNCATE … CASCADE`.
 *
 * That is correct — an integration test needs a known-empty database — and it
 * is also a loaded gun pointed at whatever `DATABASE_URL` happens to name. The
 * fallback chain used to be:
 *
 *     process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? null
 *
 * so a developer who exported `DATABASE_URL`, or sourced `.env`, or copied the
 * obvious `TEST_DATABASE_URL="$(grep DATABASE_URL .env …)"` incantation, pointed
 * nine `TRUNCATE`s at the running application's own data. On 2026-09-04 the API
 * was serving `recon_test` — the database whose *name* says it is disposable —
 * and the demo history, all 44 runs and both learned aliases, was one careless
 * command from gone. An external reviewer hit exactly this and had to create a
 * scratch database to run the suite at all.
 *
 * ── THE RULE ──
 * The suite runs against `TEST_DATABASE_URL` and nothing else, and only when the
 * database it names ends in `_test`. `DATABASE_URL` is no longer a fallback: a
 * missing `TEST_DATABASE_URL` skips the suite, which is the behaviour it always
 * had when the variable was absent, and is the safe direction to fail.
 *
 * A wrongly-pointed variable now THROWS rather than skipping. Skipping would be
 * the same silent no-op that let "pass 727, fail 0, skipped 0" mean "no
 * integration test ran at all" — the failure this file also exists to make
 * noisy (see `describeIntegration`).
 * ══════════════════════════════════════════════════════════════════════════════
 */

const RAW = process.env['TEST_DATABASE_URL'] ?? null;

/** `postgres://…/recon_v2` → `recon_v2`. Query string and trailing slash tolerated. */
function databaseNameOf(url: string): string {
  const path = url.split('?')[0] ?? url;
  const last = path.replace(/\/+$/, '').split('/').pop() ?? '';
  return last;
}

/**
 * The URL the integration suite may truncate, or `null` to skip.
 *
 * THROWS when `TEST_DATABASE_URL` is set but names a database that does not end
 * in `_test`. That is not an inconvenience to work around by renaming the check
 * — it is the check working. Point it at a disposable database.
 */
export const TEST_DB_URL: string | null = (() => {
  if (RAW === null || RAW.trim() === '') return null;
  const name = databaseNameOf(RAW);
  if (!name.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL names database "${name}", which does not end in "_test".\n`
      + `The integration suite TRUNCATEs every table in whatever this names, so it `
      + `refuses to run against a database that is not marked disposable.\n`
      + `If "${name}" really is a scratch database, rename it (or create one) so its `
      + `name ends in "_test". Never point this at DATABASE_URL.`,
    );
  }
  return RAW;
})();

/**
 * Why the suite is being skipped, or `false` to run it.
 *
 * The message names `TEST_DATABASE_URL` explicitly, because "skipped: no
 * database" reads as "nothing to do here" and is how a whole integration suite
 * disappears from a green run without anyone noticing.
 */
export const SKIP_REASON: string | false =
  TEST_DB_URL === null
    ? 'TEST_DATABASE_URL is not set — integration tests SKIPPED (this is not a pass)'
    : false;
