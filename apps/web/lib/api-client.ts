/**
 * THE ONLY place in the frontend that fetches the API (CLAUDE.md §4.7).
 *
 * One base URL, one error-envelope handler, one casing assumption. No `fetch`
 * anywhere else — not in a component, not in a route handler, not "just this once".
 *
 * The frontend does NO currency arithmetic and NO currency formatting: the API
 * sends `amountPaise` plus a pre-formatted `amountDisplay` (api-contract §0), so
 * the dashboard and the API cannot disagree about a number. In a reconciliation
 * product that would be an embarrassing bug to have on screen.
 */

const BASE_URL = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8080/api';

export class ApiClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!res.ok) {
    let code = 'INTERNAL_ERROR';
    let message = res.statusText;
    try {
      const body = await res.json() as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // Non-JSON error body — keep the status text. The API should never do this
      // (api-contract §0), so if it happens it is worth seeing verbatim.
    }
    throw new ApiClientError(res.status, code, message);
  }
  return res.json() as Promise<T>;
}

// TODO(day13): typed wrappers per endpoint, e.g.
//   export const getRun = (id: string) => apiFetch<RunDetail>(`/runs/${id}`);
