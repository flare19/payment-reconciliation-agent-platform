import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repo has a lockfile at its root and one in `apps/web`, so Next infers a
 * workspace root and warns that it may have guessed wrong. It did: this app's
 * traced files live under `apps/web`, and pinning that is the difference
 * between a deploy bundling what it needs and a deploy bundling the API and the
 * fixtures alongside it.
 */
const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  outputFileTracingRoot: here,
};
