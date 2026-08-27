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
      // for strings since ES2019, including lone surrogates.
      return JSON.stringify(value);

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
      const parts = keys.map((k) => `${JSON.stringify(k)}:${serialize(record[k])}`);
      return `{${parts.join(',')}}`;
    }

    default:
      throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
  }
}
