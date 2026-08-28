/**
 * S7 — Tier 1.5, alias-resolved (matching-engine.md §5, schema.md §6).
 *
 * NOT a new matching algorithm. Tier 1.5 substitutes human-confirmed
 * equivalences into a record's fields and then RE-RUNS THE IDENTICAL TIER 1
 * PREDICATE — `tier1Match`, imported below, never a copy of it. An alias widens
 * the *inputs* to the exact test; it never loosens the *test*, so an alias can
 * never create a match Tier 1 would have rejected.
 *
 * Two things happen here:
 *
 *  1. `counterparty_key` is populated on every pooled record (it is NULL until
 *     this stage — schema.md §3). A `merchant_name` / `counterparty_name` alias
 *     resolves `counterparty_norm` → its canonical form; with no alias the key is
 *     just a copy of the norm. This feeds Tier 2's counterparty component
 *     (schema.md §6.2 "secondary effect") and the blocking `byCounterparty`
 *     index. Even an alias that is NOT eligible for the Tier 1.5 exact re-run
 *     (conflict penalty, §6.3) still sets the key — that is exactly its
 *     "downgraded to a Tier 2 contribution only" behaviour.
 *
 *  2. `reference_id` aliases (eligible ones only) are substituted into the strong
 *     anchors, and any pair that now shares one is re-tested with `tier1Match`.
 *     A success is `ALIAS_RESOLVED_EXACT_V1`, tier `alias`, confidence 0.9500 —
 *     high, but deliberately below an exact 1.0000 because it rests on a human
 *     assertion about equivalence (schema.md §7).
 *
 * One hop only (schema.md §6.3): a resolved `canonical_value` is never itself
 * looked up again.
 *
 * On a cold run (no active aliases) this stage only copies `counterparty_norm`
 * into `counterparty_key` and produces zero alias matches — which is the correct
 * cold baseline (ADR-020).
 */

import { compareCanonical, type MemberRole } from '../../types/domain.js';
import type {
  ActiveAlias, NormalizedTransaction, ReferenceIds, RunConfig, Tier1PairMatch, Tier15Result,
} from '../../types/engine.js';
import { STRONG_ANCHOR_KEYS } from '../../types/engine.js';
import { strongAnchors } from './anchors.js';
import { tier1Match } from './tier1-exact.js';

const SEP = '::';

function scopeMatches(alias: ActiveAlias, t: NormalizedTransaction): boolean {
  return alias.scopeSource === 'any' || alias.scopeSource === t.sourceSystem;
}

/**
 * Resolve one record's counterparty key. One hop, deterministic (aliases are
 * sorted by id, and the active-alias unique index means at most one should match
 * anyway).
 */
function resolveCounterpartyKey(
  t: NormalizedTransaction, counterpartyAliases: ActiveAlias[],
): { key: string | null; appliedAliasId: string | null } {
  if (t.counterpartyNorm === null) return { key: null, appliedAliasId: null };
  for (const alias of counterpartyAliases) {
    if (!scopeMatches(alias, t)) continue;
    if (alias.normalizedValue === t.counterpartyNorm) {
      return { key: alias.canonicalValue, appliedAliasId: alias.id };
    }
  }
  return { key: t.counterpartyNorm, appliedAliasId: null };
}

/**
 * Substitute eligible `reference_id` aliases into a record's structured strong
 * anchors. Returns the (possibly unchanged) refs and the ids of aliases that
 * fired.
 */
function substituteReferenceIds(
  t: NormalizedTransaction, referenceAliases: ActiveAlias[],
): { refs: ReferenceIds; aliasIds: string[] } {
  if (referenceAliases.length === 0) return { refs: t.referenceIds, aliasIds: [] };

  let refs = t.referenceIds;
  const aliasIds: string[] = [];
  for (const key of STRONG_ANCHOR_KEYS) {
    const value = (refs as Record<string, unknown>)[key];
    if (typeof value !== 'string') continue;
    for (const alias of referenceAliases) {
      if (!scopeMatches(alias, t)) continue;
      if (alias.normalizedValue === value) {
        if (refs === t.referenceIds) refs = { ...t.referenceIds };
        (refs as Record<string, string>)[key] = alias.canonicalValue;
        aliasIds.push(alias.id);
        break; // one hop
      }
    }
  }
  return { refs, aliasIds };
}

export function runTier15(
  pool: NormalizedTransaction[],
  config: RunConfig,
  aliases: readonly ActiveAlias[],
  /** Transaction ids already in a confirmed S6 match — skipped by the exact re-run. */
  alreadyMatchedIds: ReadonlySet<string> = new Set(),
): Tier15Result {
  const active = [...aliases].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const counterpartyAliases = active.filter(
    (a) => a.aliasType === 'merchant_name' || a.aliasType === 'counterparty_name',
  );
  // §6.3: only eligible aliases participate in the Tier 1.5 exact re-run.
  const referenceAliases = active.filter(
    (a) => a.aliasType === 'reference_id' && a.eligibleForAliasTier,
  );

  // ── 1. counterparty_key on every pooled record ──────────────────────────────
  const resolutions: Tier15Result['counterpartyResolutions'] = [];
  const resolvedPool = pool.map((t) => {
    const { key, appliedAliasId } = resolveCounterpartyKey(t, counterpartyAliases);
    if (appliedAliasId !== null) {
      resolutions.push({ transactionId: t.id, counterpartyKey: key, appliedAliasId });
    }
    return key === t.counterpartyKey ? t : { ...t, counterpartyKey: key };
  });

  // ── 2. reference-id substitution + Tier 1 re-run ────────────────────────────
  const matches: Tier1PairMatch[] = [];
  if (referenceAliases.length > 0) {
    const subbed = new Map<string, { txn: NormalizedTransaction; aliasIds: string[] }>();
    for (const t of resolvedPool) {
      if (t.statusNorm !== 'reconcilable') continue;
      const { refs, aliasIds } = substituteReferenceIds(t, referenceAliases);
      subbed.set(t.id, { txn: refs === t.referenceIds ? t : { ...t, referenceIds: refs }, aliasIds });
    }

    // Anchor index over the SUBSTITUTED values.
    const byAnchor = new Map<string, string[]>();
    for (const { txn } of subbed.values()) {
      for (const anchor of strongAnchors(txn.referenceIds)) {
        const slot = anchor.key + SEP + anchor.value;
        const list = byAnchor.get(slot);
        if (list === undefined) byAnchor.set(slot, [txn.id]);
        else list.push(txn.id);
      }
    }

    const seen = new Set<string>();
    for (const slot of [...byAnchor.keys()].sort()) {
      const ids = byAnchor.get(slot)!;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const ea = subbed.get(ids[i]!)!;
          const eb = subbed.get(ids[j]!)!;
          const [a, b] = compareCanonical(ea.txn, eb.txn) <= 0 ? [ea, eb] : [eb, ea];
          if (a.txn.sourceSystem === b.txn.sourceSystem) continue;
          if (alreadyMatchedIds.has(a.txn.id) || alreadyMatchedIds.has(b.txn.id)) continue;
          const pairKey = `${a.txn.id}|${b.txn.id}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);

          const usedAliases = [...new Set([...a.aliasIds, ...b.aliasIds])];
          if (usedAliases.length === 0) continue; // this pair already shared a RAW anchor — S6's job

          const m = tier1Match(a.txn, b.txn, config);
          if (m === null) continue;
          matches.push({
            ...m,
            ruleId: 'ALIAS_RESOLVED_EXACT_V1',
            aId: a.txn.id,
            bId: b.txn.id,
            aRole: a.txn.sourceSystem as MemberRole,
            bRole: b.txn.sourceSystem as MemberRole,
            tier: 'alias',
            confidence: 0.95,
            aliasIds: usedAliases,
            reason: `after substituting a confirmed alias, ${m.reason}`,
          });
        }
      }
    }
  }

  return { pool: resolvedPool, matches, counterpartyResolutions: resolutions };
}
