'use client';

import { useEffect } from 'react';
import styles from './status.module.css';

/**
 * ui-spec §9: every error surface names the failing endpoint.
 *
 * During a live demo, a failure you can diagnose in five seconds is survivable
 * and an opaque one is not. So this page prints the code and the path verbatim
 * rather than a friendly apology — the audience for this screen is the person
 * presenting, not the person watching.
 *
 * `ApiClientError`'s fields do not survive the server/client boundary, so the
 * code and path are recovered from the serialized message.
 */
export default function DashboardError(
  { error, reset }: { error: Error & { digest?: string }; reset: () => void },
) {
  useEffect(() => {
    console.error('[dashboard]', error);
  }, [error]);

  // `ApiClientError`'s fields do not survive the server/client boundary, so the
  // cause is recovered from the message. Deliberately conservative: anything
  // that is not recognisably a transport or contract failure is treated as a
  // rendering fault, because that is the honest default for an error thrown
  // inside a component.
  const looksLikeApiFailure = /API_UNREACHABLE|Failed to fetch|NetworkError|ECONNREFUSED|fetch failed|CORS|\b[45]\d{2}\b/i
    .test(error.message);

  return (
    <main id="main" className={styles.wrap}>
      <p className="label">Request Failed</p>
      <h1 className={styles.title}>The dashboard could not load this run.</h1>

      <pre className={styles.detail}>
        <code>{error.message}</code>
      </pre>

      {/* ONLY BLAME THE API WHEN IT IS PLAUSIBLY THE API.
          This page used to print the base-URL advice unconditionally, so a
          React render error — `Cannot read properties of null` — told the
          reader to go and check CORS. An error surface that names the wrong
          cause is worse than one that names none, because it sends someone
          confidently in the wrong direction. */}
      {looksLikeApiFailure ? (
        <p className={styles.body}>
          The API is expected at{' '}
          <code className={styles.inline} translate="no">
            {process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8080/api'}
          </code>
          . Check that it is running and that <code className={styles.inline}>CORS_ORIGIN</code>{' '}
          allows this origin.
        </p>
      ) : (
        <p className={styles.body}>
          This is a rendering error, not a connection problem — the data arrived and the page
          failed to draw it. The message above is the actual fault; nothing is wrong with the API
          or your network.
        </p>
      )}

      {error.digest && (
        <p className={styles.digest}>
          Digest <span className="num">{error.digest}</span>
        </p>
      )}

      <button type="button" className={styles.retry} onClick={reset}>
        Try Again
      </button>
    </main>
  );
}
