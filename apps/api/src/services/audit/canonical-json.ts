/**
 * Canonical JSON — a byte-stable serialization for hashing.
 *
 * The audit hash chain (ADR-042) is only meaningful if the same logical entry
 * always produces the same bytes. Ordinary `JSON.stringify` does not guarantee
 * that, and three things in this system actively break it:
 *
 *  1. **Object key order.** `JSON.stringify` emits keys in insertion order, and
 *     Postgres `jsonb` does NOT preserve insertion order — it stores keys sorted
 *     by length then bytes. So an entry hashed before the write and verified
 *     after the read would disagree on any object with more than one key. Sorting
 *     keys here makes the two agree by construction.
 *  2. **Dates.** A `Date` from the driver and an ISO string from the application
 *     are the same instant and different bytes. Everything becomes ISO-8601 UTC.
 *  3. **Absent vs null.** `undefined` disappears from `JSON.stringify` output but
 *     round-trips from Postgres as `null`. Both normalise to `null` here, so
 *     "the field was not set" has one representation.
 *
 * Arrays keep their order: in this schema array order is meaningful (candidate
 * lists, secondary flags in precedence order), so sorting them would destroy
 * information the entry is asserting.
 *
 *  4. **A NUL character or an unpaired surrogate (see #24).** `JSON.stringify`
 *     produces well-formed, byte-stable JSON text for both -- a NUL becomes a
 *     six-character Unicode escape sequence, and a lone surrogate round-trips
 *     as itself -- but Postgres's `jsonb` input parser rejects that escape
 *     sequence outright ("unsupported Unicode escape sequence") and rejects
 *     an unpaired surrogate ("invalid input syntax for type json"), because
 *     neither can be represented in jsonb's internal string storage. Both are
 *     ordinary artefacts of messy source data (a stray NUL byte, a truncated
 *     multi-byte sequence), so every string is sanitized before
 *     serialization: NUL is stripped, and an unpaired surrogate becomes the
 *     Unicode replacement character. This runs before hashing, not after, so
 *     the hash and the stored bytes agree on the sanitized form -- the same
 *     property key normalisation and date normalisation already have.
 */

export type CanonicalValue =
  | string | number | boolean | null | undefined | Date
  | CanonicalValue[] | { [k: string]: CanonicalValue };

export function canonicalJson(value: CanonicalValue): string {
  return serialize(value);
}

/**
 * The value as it will exist AFTER a round trip through a `jsonb` column.
 *
 * This is the function that makes the hash and the stored bytes the same thing
 * rather than two things expected to agree (issue #17). `JSON.stringify` and
 * `canonicalJson` disagree in exactly one direction — `stringify` DROPS an
 * `undefined`-valued key, `canonicalJson` emits `"k":null` — so an entry hashed
 * from the caller's object and stored via `stringify` could differ from the row
 * read back, and verification would report tampering on an untouched log.
 *
 * Running the value through `canonicalJson` and back gives the post-storage
 * shape: `undefined` becomes `null`, `Date` becomes an ISO string, and values
 * JSON cannot represent still throw rather than silently becoming `null`. It is
 * idempotent — `canonicalize(canonicalize(v))` equals `canonicalize(v)` — which
 * is what lets verification apply it to an already-stored row safely.
 */
export function canonicalize(value: CanonicalValue): CanonicalValue {
  return JSON.parse(canonicalJson(value)) as CanonicalValue;
}

const LOW_SURROGATE_MIN = 0xDC00;
const LOW_SURROGATE_MAX = 0xDFFF;
const HIGH_SURROGATE_MIN = 0xD800;
const HIGH_SURROGATE_MAX = 0xDBFF;
const REPLACEMENT_CHAR = '�';

/**
 * Strip NUL, and replace an unpaired UTF-16 surrogate with the replacement
 * character — see the NUL/surrogate section of this file's docstring (#24).
 * A no-op for any string that does not contain one, so no existing hash
 * changes.
 *
 * Exported so `toStoredForm` (hash-chain.ts) can apply the identical
 * transform to `reason` — a plain TEXT column that never passes through
 * `canonicalJson`/`canonicalize` at write time, but is still walked by
 * `serialize()` when the whole entry is hashed. Without this, a `reason`
 * containing a NUL would hash as sanitized-by-`serialize()` here but arrive
 * at the database unsanitized via the raw SQL parameter, so the row that
 * gets stored would not be the row that was hashed.
 */
export function sanitizeAuditString(s: string): string {
  let out = '';
  let changed = false;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code === 0) { changed = true; continue; }
    if (code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX) {
      const next = s.charCodeAt(i + 1);
      if (next >= LOW_SURROGATE_MIN && next <= LOW_SURROGATE_MAX) {
        out += s[i]! + s[i + 1]!;
        i += 1;
        continue;
      }
      out += REPLACEMENT_CHAR; changed = true; continue;
    }
    if (code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX) {
      out += REPLACEMENT_CHAR; changed = true; continue;
    }
    out += s[i];
  }
  return changed ? out : s;
}

function serialize(value: CanonicalValue): string {
  if (value === null || value === undefined) return 'null';

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('canonicalJson: invalid Date cannot be serialized deterministically');
    }
    return JSON.stringify(value.toISOString());
  }

  switch (typeof value) {
    case 'string':
      // JSON.stringify has produced well-formed, deterministically escaped output
      // for strings since ES2019, including lone surrogates — but "well-formed
      // JSON text" is not "storable by jsonb"; see this file's docstring, item 4.
      return JSON.stringify(sanitizeAuditString(value));

    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      // NaN and Infinity silently become `null` under JSON.stringify, which would
      // make two different entries hash identically. Refuse instead.
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJson: ${String(value)} is not representable in JSON`);
      }
      // -0 and 0 are the same JSON number; normalise so they cannot differ.
      return JSON.stringify(value === 0 ? 0 : value);

    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => serialize(v)).join(',')}]`;
      }
      const record = value as { [k: string]: CanonicalValue };
      // Sort by code unit. Locale-aware comparison would make the hash depend on
      // the machine's locale, which is exactly the class of bug this file exists
      // to remove.
      const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const parts = keys.map((k) => `${JSON.stringify(sanitizeAuditString(k))}:${serialize(record[k])}`);
      return `{${parts.join(',')}}`;
    }

    default:
      throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
  }
}
