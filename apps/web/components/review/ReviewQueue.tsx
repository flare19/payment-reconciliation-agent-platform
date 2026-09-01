'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Paginate } from '@/components/ui/Paginate';
import { count } from '@/lib/format';
import { hrefWith } from '@/lib/run-context';
import type { Pagination, ReviewItem } from '@/types/api';
import { ReviewCard } from './ReviewCard';
import styles from './ReviewQueue.module.css';

/**
 * THE QUEUE DRAINS. Approving does not park you on a confirmation screen.
 *
 * The first build showed a "done" panel after each decision and told the reader
 * to reload. That was wrong twice over:
 *
 *   1. **`<ReviewCard>` was rendered without a `key`.** React reconciles by
 *      component type and position, so navigating `?page=1 → ?page=2` reused the
 *      same instance and the `done` state SURVIVED the navigation. Every
 *      subsequent proposal rendered as the confirmation screen for the first
 *      one, and the only thing that changed was the page number in the
 *      server-rendered `Paginate` below it. The card is keyed on `matchId` now,
 *      so a different proposal is a different instance and every field —
 *      reviewer, note, reason, the alias checkbox, a pending conflict — resets
 *      with it.
 *
 *   2. **An approved proposal LEAVES the queue**, so "next" never meant what the
 *      button implied. Refreshing in place is the honest model: the decision is
 *      recorded, the total drops, and the next pending proposal appears where
 *      the last one was. That is also how a queue is actually worked.
 *
 * THE FLASH LIVES HERE, NOT IN THE CARD, precisely because the card is keyed.
 * A confirmation stored inside a component that unmounts on success would erase
 * itself at the moment it was needed.
 */
export function ReviewQueue(
  { item, pagination, runQ }:
  {
    item: ReviewItem;
    pagination: Pagination;
    /**
     * The run id to carry in links, or undefined when it is the default run.
     *
     * A STRING, not the `hrefFor` callback the first version took. Functions
     * cannot cross the server-to-client boundary — React has to serialise every
     * prop into the RSC payload, and a closure has no serialisation. It is a
     * runtime rule, so `tsc` accepted the callback and the page threw on load.
     */
    runQ: string | undefined;
  },
) {
  const hrefFor = (p: number) =>
    hrefWith('/review', { run: runQ, page: p === 1 ? undefined : p });

  const router = useRouter();
  /**
   * Carries an `id` so two identical messages in a row still re-trigger the
   * dismiss timer — `setFlash('Approved.')` twice is the same value, and a
   * `[flash]` effect would not re-run on the second one.
   */
  const [flash, setFlash] = useState<{ id: number; message: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  /**
   * THE CONFIRMATION IS TRANSIENT, and it has to be told so twice.
   *
   * This component is deliberately NOT keyed — that is what lets the message
   * survive the keyed card remounting underneath it. The cost of that choice is
   * that it also survives `?page=` navigation, so without these two effects the
   * banner followed the reviewer through every subsequent proposal, announcing
   * an approval they made three screens ago. That is the same defect as the
   * unkeyed card it replaced, moved up one level: state outliving the event it
   * describes.
   */
  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(timer);
  }, [flash]);

  // Paging away is an explicit "I am done with that one".
  useEffect(() => { setFlash(null); }, [pagination.page]);

  function onCompleted(message: string) {
    setFlash({ id: Date.now(), message });
    // Pull the next proposal into this slot. `total` on the refreshed render is
    // the live count — there is no second, guessed number anywhere now.
    startTransition(() => router.refresh());
  }

  return (
    <div className={styles.wrap}>
      {flash && (
        <p key={flash.id} className={styles.flash} aria-live="polite">
          <span className={styles.tick} aria-hidden="true">✓</span>
          {flash.message}
          {isPending && <span className={styles.loading}> Loading the next one…</span>}
        </p>
      )}

      <div className={isPending ? styles.stale : undefined}>
        <ReviewCard
          key={item.matchId}
          item={item}
          total={pagination.total}
          page={pagination.page}
          onCompleted={onCompleted}
        />
      </div>

      <Paginate pagination={pagination} unit="proposals" hrefFor={hrefFor} />

      <p className={styles.note}>
        <span className="num">{count(pagination.total)}</span> still waiting. A decision here is
        final in the audit log — the trail is append-only, so a later change of mind is a new
        entry rather than an edit to this one.
      </p>
    </div>
  );
}
