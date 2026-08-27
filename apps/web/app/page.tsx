/**
 * Dashboard — the landing screen.
 *
 * NON-NEGOTIABLE (ui-spec §0): this page NEVER shows an empty state. The deployed
 * app opens on a completed run, fetched server-side. A judge who lands on an
 * upload form will close the tab before finding out the engine works.
 *
 * Block order is the argument the project is making, rendered:
 *   1. match rate · FALSE POSITIVES · cold start · ceiling  (equal weight, one row)
 *   2. tier attribution bar
 *   3. exceptions by category
 *   4. throughput + LLM cost
 *   4.5 the Analyst: verdicts, false-despair recovered, hallucinated resolutions: 0
 *   5. run picker
 */
export default function DashboardPage() {
  return (
    <main>
      <h1>Payment Reconciliation Engine</h1>
      <p>TODO(day13): dashboard per docs/ui-spec.md §2.</p>
    </main>
  );
}
