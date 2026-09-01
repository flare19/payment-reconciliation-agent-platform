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

  return (
    <main id="main" className={styles.wrap}>
      <p className="label">Request Failed</p>
      <h1 className={styles.title}>The dashboard could not load this run.</h1>

      <pre className={styles.detail}>
        <code>{error.message}</code>
      </pre>

      <p className={styles.body}>
        The API is expected at{' '}
        <code className={styles.inline} translate="no">
          {process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8080/api'}
        </code>
        . Check that it is running and that <code className={styles.inline}>CORS_ORIGIN</code>{' '}
        allows this origin.
      </p>

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
