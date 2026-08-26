# Answer keys — NEVER read by `apps/api`

Ground truth lives here as JSON, written by `tools/generate` as a byproduct of
generation (validation-strategy §1). **No module under `apps/api/src` may import
from this directory** (ADR-021).

That rule is the foundation of every accuracy claim in the project: if the engine
could read the key, "does any code path use it?" becomes something you have to
audit rather than something that is structurally impossible.

It is enforced by a test, not by convention — see
`apps/api/tests/unit/truth-leak-guard.test.ts` (testing-strategy §3).

Scoring happens offline in `tools/score/`, which joins engine output (fetched from
the API) to the key (read from disk) after the fact.
