'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ApiClientError, askQuestion, resolveCitation } from '@/lib/api-client';
import type { ResolvedCitation } from '@/lib/api-client';
import { ModelVoice } from '@/components/ui/ModelVoice';
import { hrefWith } from '@/lib/run-context';
import type { RunQuestion } from '@/types/api';
import styles from './AskAboutRun.module.css';

/**
 * THE ONLY FREE-TEXT BOX IN THE PRODUCT (agent-design.md §9, endpoint 28).
 *
 * `AskAnalyst` — the other control that spends money — is handed its subject:
 * one exception, one price, one button. This one accepts a sentence, which
 * makes it a different kind of surface and not merely a bigger one:
 *
 *   · a person can ask something the run cannot answer, and the honest result
 *     is the agent saying so rather than inventing;
 *   · a person can ask something enormous, so the length bound is a SPEND bound
 *     (the question is replayed into every one of up to 6 turns);
 *   · a stranger on a public demo can ask at all, which is why the server's
 *     quota is four checks deep and not a courtesy.
 *
 * SO IT KEEPS THE ARM→CONFIRM STEP, for the reason `AskAnalyst` documents: a
 * judge clicking through a demo clicks every button once, and the gap between
 * one button and two is the gap between a stranger spending the budget and not.
 *
 * ── IT WAITS, VISIBLY, AND SAYS WHY ──
 * Endpoint 28 is synchronous. There is no 202, no poll target, and no status
 * column to poll — the answer arrives in the response body after up to ~30
 * seconds of bounded work. A button that simply goes quiet for half a minute
 * reads as a broken page, so the waiting state counts elapsed seconds and names
 * what is happening. The timer is honest about duration and claims nothing
 * about progress: this component cannot see the agent's steps, so it does not
 * draw a progress bar it would have to invent.
 *
 * ── AN UNGROUNDED ANSWER IS SHOWN AS REFUSED, NOT AS AN ANSWER ──
 * The A3 gate strips citations from an answer it rejects and the row is
 * persisted anyway, so the refusal is visible instead of silently retried.
 * Rendering that prose in the same frame as a grounded answer would undo the
 * gate: the whole value of refusing is that a reader can tell the difference.
 *
 * ── THE ANSWER IS THE MODEL'S VOICE, AND WEARS NO PROVENANCE (ADR-139) ──
 * The prose goes through `ModelVoice`; the grounding banner, the counts and the
 * citation list stay in the interface's own voice, because a reader must be
 * able to tell a claim the model made from a claim we make on its behalf.
 *
 * It was written once with `--verified` on the grounded state, which is exactly
 * the mistake `globals.css` warns about in the line above that token: a reader
 * who has learned teal as "checked against an answer key" must not meet it on a
 * paragraph nobody checked. Grounded means every id it cited came back from a
 * tool it really called -- a real and valuable property, and NOT the same
 * property as a figure measured against ground truth.
 */

/** Mirrors `AGENT_DEFAULTS.qa.maxQuestionChars`. The SERVER owns the bound. */
const MAX_CHARS = 500;

export function AskAboutRun(
  { runId, runQ, examples, history, resolvedCitations }: {
    runId: string;
    /**
     * The `?run=` value to carry onto citation links, or `undefined` when this
     * is the default run. Citation ids are per-run — a link to `/exceptions/:id`
     * or `/records/:id` that drops the run lands on the wrong run's data, or
     * on a not-found page.
     */
    runQ: string | undefined;
    /**
     * Every citation id across `history`, resolved SERVER-SIDE to a record or an
     * exception (id → {@link ResolvedCitation}). A freshly asked answer's ids
     * are not in here — the component resolves those few in the browser.
     */
    resolvedCitations: Record<string, ResolvedCitation>;
    examples: readonly string[];
    /**
     * Questions already answered on this run, newest first, server-rendered.
     *
     * Free to show and true even when the agent is switched off, which is the
     * point: on a keyless deploy this section is still evidence that the loop
     * ran and what it cost, rather than a button that only ever errors.
     */
    history: readonly RunQuestion[];
  },
) {
  const router = useRouter();
  const [question, setQuestion] = useState('');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [answer, setAnswer] = useState<RunQuestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // Counts up only while a question is in flight. Duration is a fact this
  // component can actually observe; progress is not, so it reports the one and
  // never the other.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const tooLong = question.length > MAX_CHARS;
  const ready = question.trim().length > 0 && !tooLong;

  function seed(text: string) {
    setQuestion(text);
    setArmed(false);
    setError(null);
    setAnswer(null);
    boxRef.current?.focus();
  }

  async function ask() {
    setBusy(true);
    setError(null);
    setAnswer(null);
    setElapsed(0);
    try {
      const res = await askQuestion(runId, question.trim());
      setAnswer(res);
      // The history list below is server-rendered, so the new row only appears
      // after a refresh. The answer above is already on screen either way.
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'AGENT_QUOTA_EXCEEDED') {
        // The server's message names WHICH of the four bounds bound, which is
        // more useful than anything this component could say, so it is shown
        // verbatim rather than replaced with a generic line.
        setError(err.message);
      } else if (err instanceof ApiClientError && err.code === 'AGENT_DISABLED') {
        setError(
          'The Analyst is switched off on this deployment — there is no API key configured. '
          + 'Everything else on this page was produced without one.',
        );
      } else if (err instanceof ApiClientError && err.code === 'RUN_NOT_COMPLETE') {
        setError('This run is still going. The Analyst answers questions about finished runs, '
          + 'so that it never reasons over half an engine’s output.');
      } else {
        setError(err instanceof ApiClientError
          ? `${err.code} (${err.status}) at ${err.path} — ${err.message}`
          : String(err));
      }
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  return (
    <section className={styles.wrap} aria-labelledby="ask-title">
      <h2 id="ask-title" className="label">Ask About This Run</h2>
      <p className={styles.note}>
        Ten of the Analyst&rsquo;s eleven read-only tools, pointed at a question instead of an
        exception — the batch subset search is left out, because a question should not spend a
        two-second compute budget. It answers from this run&rsquo;s real records — or says the data
        does not show it.
      </p>

      <ul className={styles.examples}>
        {examples.map((ex) => (
          <li key={ex}>
            <button
              type="button"
              className={styles.example}
              onClick={() => seed(ex)}
              disabled={busy}
            >
              {ex}
            </button>
          </li>
        ))}
      </ul>

      <label className={styles.label} htmlFor="ask-box">Or ask your own</label>
      <textarea
        id="ask-box"
        ref={boxRef}
        className={styles.box}
        value={question}
        rows={3}
        placeholder="Why wasn&rsquo;t this settlement matched?"
        onChange={(e) => { setQuestion(e.target.value); setArmed(false); }}
        disabled={busy}
        aria-describedby="ask-count"
      />
      {/* `aria-live` ONLY once the bound is broken. A counter that announces on
          every keystroke is noise a screen-reader user cannot escape while
          typing; the number is still readable on demand via `aria-describedby`,
          and the one moment it must interrupt is when it turns into a refusal
          the server will make. */}
      <p
        id="ask-count"
        className={tooLong ? styles.countOver : styles.count}
        aria-live={tooLong ? 'assertive' : 'off'}
      >
        <span className="num">{question.length}</span> / {MAX_CHARS} characters
        {tooLong && ' — the question is replayed into every step, so length is a cost'}
      </p>

      {!armed ? (
        <button
          type="button"
          className={styles.arm}
          onClick={() => { setArmed(true); setError(null); }}
          disabled={busy || !ready}
        >
          Ask the Analyst
        </button>
      ) : (
        <div className={styles.confirm}>
          <p className={styles.cost}>
            One question costs about <strong className="num">$0.08</strong> of live model credit —
            a measured figure, not an estimate — and is answered in up to six bounded steps.
            <span className={styles.costThen}>
              It is saved with its cost and its citations when it lands, so the answer stays on
              this page for anyone after you — and the bill is visible rather than inferred.
            </span>
          </p>
          <div className={styles.buttons}>
            <button type="button" className={styles.go} onClick={ask} disabled={busy}>
              {busy ? 'Asking…' : 'Ask it'}
            </button>
            <button
              type="button"
              className={styles.cancel}
              onClick={() => setArmed(false)}
              disabled={busy}
            >
              Not now
            </button>
          </div>
        </div>
      )}

      <div aria-live="polite">
        {busy && (
          <p className={styles.waiting}>
            Working — reading records, then answering from what it actually retrieved.{' '}
            <span className="num">{elapsed}s</span>
          </p>
        )}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {answer && <Answer q={answer} runQ={runQ} resolved={resolvedCitations} />}
      </div>

      {history.length > 0 && (
        <div className={styles.history}>
          <h3 className={styles.historyTitle}>
            Already asked on this run
            <span className={styles.historyCount}>
              <span className="num">{history.length}</span>
            </span>
          </h3>
          <p className={styles.historyNote}>
            Answered once, kept with their citations and their cost. Re-reading one is free.
          </p>
          <ul className={styles.historyList}>
            {history.map((h) => (
              <li key={h.questionId} className={styles.historyItem}>
                <p className={styles.asked}>{h.question}</p>
                <Answer q={h} runQ={runQ} resolved={resolvedCitations} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * One answer, rendered so its GROUNDING STATE is the first thing visible.
 *
 * A refused answer keeps its prose — it is the evidence of what the gate caught
 * — but it is framed as refused and carries no citations, because the gate
 * already removed them. Presenting the two states identically would make the
 * gate decorative.
 */
function Answer(
  { q, runQ, resolved }: {
    q: RunQuestion;
    runQ: string | undefined;
    resolved: Record<string, ResolvedCitation>;
  },
) {
  return (
    <article className={q.groundingPassed ? styles.answerBlock : styles.refusedBlock}>
      <p className={styles.answerHead}>
        <span className={q.groundingPassed ? styles.ok : styles.bad}>
          {q.groundingPassed
            ? 'Grounded in records it retrieved'
            : 'Refused by the grounding gate'}
        </span>
        <span className={styles.meta}>
          <span className="num">{q.steps}</span> step{q.steps === 1 ? '' : 's'} &middot;{' '}
          <span className="num">{q.toolCalls}</span> tool call{q.toolCalls === 1 ? '' : 's'}
          {q.costUsd !== null && (
            <> &middot; <span className="num">${q.costUsd.toFixed(4)}</span></>
          )}
        </span>
      </p>

      {!q.groundingPassed && (
        <p className={styles.refusedWhy}>
          It cited something no tool returned while answering this question, so the answer was
          rejected before it could be presented as evidence and its citations were removed. The
          text is kept because the refusal is the result worth seeing.
        </p>
      )}

      {/* AN EMPTY ANSWER IS A REAL OUTCOME, and it must not render as an empty
          quotation. A question that exhausts its tool-call budget before
          writing anything returns `answer: ""` -- measured, not hypothetical:
          one of the four live questions did exactly that, spending $0.0466 and
          producing nothing. `ModelVoice` would set that as an open quote around
          silence, which reads as a broken component rather than as what it is. */}
      {q.answer !== null && q.answer.trim() !== '' ? (
        <ModelVoice attribution={<>the Analyst, after <span className="num">{q.toolCalls}</span>{' '}
          tool call{q.toolCalls === 1 ? '' : 's'} against this run</>}
        >
          {q.answer}
        </ModelVoice>
      ) : (
        <p className={styles.noAnswer}>
          It spent its <span className="num">{q.toolCalls}</span>-call tool budget without
          reaching an answer, so there is nothing to show. The cost above was still incurred —
          which is the honest thing to display rather than a retry that hides it.
        </p>
      )}

      {q.citations.length > 0 && (
        <>
          <p className={styles.citeLabel}>
            Cited records &mdash; each one a row a tool actually returned
          </p>
          <CitationList ids={q.citations} runQ={runQ} resolved={resolved} />
        </>
      )}
    </article>
  );
}

/**
 * A citation id can be a TRANSACTION or an EXCEPTION — the grounding gate
 * accepts any id that appeared in a tool result, and `get_transaction` yields
 * transaction ids while `get_exception` / `find_similar_exceptions` yield
 * exception ids. Linking them all at `/records/:id` sent roughly a third of
 * them to a not-found page (found live, 2026-09-03: an exception citation on a
 * Q&A history answer). `resolveCitation` looks each id up and returns the right
 * path.
 *
 * EVERY ANSWER ALREADY ON THE PAGE is resolved SERVER-SIDE by `analyst/page.tsx`
 * and handed down in `resolved` — same as the exception-detail panel, no client
 * waterfall, real labels in the first paint. The only ids not in that map are
 * the ones from an answer the reader just asked in this browser; those few are
 * resolved here, in parallel, and until they land they render as plain text
 * rather than as the `/records/:id` guess that was wrong before.
 */
function CitationList(
  { ids, runQ, resolved }: {
    ids: string[];
    runQ: string | undefined;
    resolved: Record<string, ResolvedCitation>;
  },
) {
  const distinct = [...new Set(ids)];
  const missing = distinct.filter((id) => !(id in resolved));
  const [clientResolved, setClientResolved] = useState<Record<string, ResolvedCitation>>({});

  useEffect(() => {
    if (missing.length === 0) return;
    let live = true;
    Promise.all(
      missing.map((id) =>
        resolveCitation(id).catch(
          (): ResolvedCitation => ({
            id, kind: 'unknown', href: null, label: id.slice(0, 8), detail: null,
          }),
        ),
      ),
    ).then((rs) => {
      if (!live) return;
      setClientResolved((prev) => {
        const next = { ...prev };
        for (const r of rs) next[r.id] = r;
        return next;
      });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing.join(',')]);

  return (
    <ul className={styles.cites}>
      {distinct.map((id) => {
        const c = resolved[id] ?? clientResolved[id] ?? null;
        if (c === null) {
          // Not yet resolved (a just-asked answer, mid-lookup). Plain text, not
          // a guessed link.
          return <li key={id}><span className={styles.cite}>{id.slice(0, 8)}</span></li>;
        }
        return (
        <li key={c.id}>
          {c.href === null ? (
            <span
              className={`${styles.cite} ${styles.citeDead}`}
              title="No record or exception was found for this id"
            >
              unresolved · {c.label}
            </span>
          ) : (
            <Link href={hrefWith(c.href, { run: runQ })} className={styles.cite}>
              {c.kind === 'transaction' ? 'record' : 'exception'} · {c.label}
              {c.detail ? ` · ${c.detail}` : ''}
            </Link>
          )}
        </li>
        );
      })}
    </ul>
  );
}
