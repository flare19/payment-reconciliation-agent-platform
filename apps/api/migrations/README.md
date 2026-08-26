# Migrations

`NNN_snake_case.sql`, zero-padded, **forward-only** (ADR-022).

- A bad migration is fixed by a **new** migration, never by editing a shipped one.
  The runner stores a checksum per file and refuses to start if one changes.
- Each file runs in its own transaction.
- `runs.status`, taxonomy values and other closed sets are `TEXT` + `CHECK`, not
  native enums, so adding a value is one `ALTER` (schema.md §0).
- Every TypeScript union in `src/types/domain.ts` mirrors a CHECK here. Change
  both in the same commit.

The authoritative shape of every table is [docs/schema.md](../../../docs/schema.md).
