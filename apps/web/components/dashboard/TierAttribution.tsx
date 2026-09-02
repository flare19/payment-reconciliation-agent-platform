import { SegmentBar, type Segment } from '@/components/ui/SegmentBar';
import { count } from '@/lib/format';
import type { EngineMetrics } from '@/types/api';
import styles from './TierAttribution.module.css';

/**
 * ui-spec §2 block 2 — how the match rate was earned, in one glance.
 *
 * TWO CORRECTIONS TO THE SPEC'S SEGMENT LIST, both forced by what the data
 * actually is:
 *
 * 1. `identityEstablished` IS NOT A SEGMENT. `tierPairCounts` builds the tier
 *    buckets from the internal pairs of every group; `run-metrics.ts` then
 *    grafts `identityEstablished` onto the same object as a separate diagnostic
 *    — it counts S8 verdicts, not pairs, and it is not part of the sum. Drawing
 *    it as a slice would inflate the bar by exactly its own value. It is shown
 *    beside the bar instead, which is also where it means more: 9 is the number
 *    of amount/timing verdicts Tier 1 declined and S8 settled.
 *
 * 2. `unmatched` IS NOT A SEGMENT EITHER. This bar's unit is PAIRS. Unmatched is
 *    a count of RECORDS. One bar cannot divide two different units without
 *    lying about at least one of them, so unmatched records live in the
 *    exception block, where the unit is records throughout.
 *
 * The ramp is ONE HUE, darkening toward the strongest tier, because these are
 * ordered by strength of evidence and eight unrelated colours would deny that.
 */
export function TierAttribution({ engine }: { engine: EngineMetrics }) {
  const t = engine.tierAttribution;
  const get = (k: string) => t[k] ?? 0;

  const segments: Segment[] = [
    {
      key: 'exact', label: 'Exact', value: get('exact'), color: 'var(--tier-1)',
      gloss: 'A shared strong reference id — payment id, settlement id, well-formed RRN.',
    },
    {
      key: 'alias', label: 'Alias-resolved', value: get('alias'), color: 'var(--tier-2)',
      gloss: 'Exact, once a counterparty alias a human taught the system was substituted in.',
    },
    {
      key: 'fuzzy', label: 'Fuzzy', value: get('fuzzy'), color: 'var(--tier-3)',
      gloss: 'Scored on amount, date, anchor agreement and counterparty; above the auto-confirm threshold.',
    },
    {
      key: 'batch', label: 'Batch-decomposed', value: get('batch'), color: 'var(--tier-4)',
      gloss: 'A netted bank credit split back into the payments that compose it.',
    },
    {
      key: 'implied', label: 'Implied', value: get('implied'), color: 'var(--tier-5)',
      gloss: 'The third pair in a three-way group — real, and carried by the two pairs that meet at its anchor.',
    },
    {
      key: 'manual', label: 'Manual', value: get('manual'), color: 'var(--tier-6)',
      gloss: 'A human asserted these records are the same. Not an engine claim.',
    },
    {
      key: 'unattributed', label: 'Unattributed', value: get('unattributed'),
      color: 'var(--tier-void)', isVoid: true,
      gloss: 'A pair inside a confirmed group that no tier and no rule accounts for. Must be zero.',
    },
  ];

  // Summed from the segments actually drawn, so the bar and its total can never
  // disagree — and so adding `identityEstablished` to the list would visibly
  // change the total rather than quietly changing the proportions.
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const identity = get('identityEstablished');

  return (
    <div className={styles.wrap}>
      <SegmentBar
        segments={segments}
        total={total}
        unit="Pairs"
        caption="Confirmed pairs by the tier that produced them"
      />

      <aside className={styles.sidebar}>
        <div className={styles.stat}>
          <span className="label">Pairs Matched</span>
          <span className={`${styles.statValue} num`}>{count(total)}</span>
          <p className={styles.statNote}>
            Every internal pair of every group the engine assembled.
          </p>
        </div>

        <div className={styles.stat}>
          <span className="label">Same ID, Different Details</span>
          <span className={`${styles.statValue} num`}>{count(identity)}</span>
          <p className={styles.statNote}>
            Not a rule and not in the bar — pairs whose reference IDs agree exactly, but whose
            amount or date does not.
          </p>
        </div>
      </aside>
    </div>
  );
}
