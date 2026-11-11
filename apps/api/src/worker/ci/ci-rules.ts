import type { PrCheck } from '../github/github-client';

export type CiVerdict = 'pass' | 'fail' | 'pending' | 'timeout';

/**
 * The state of a PR's checks (F12): no checks at all counts as passing; any failed (or cancelled) check is a failure; otherwise
 * pending checks are waited for until `ciTimeoutMin` has passed since the wait started.
 */
export function decideCi(args: { checks: readonly PrCheck[]; waitedMs: number; timeoutMs: number }): CiVerdict {
  const { checks } = args;
  if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return 'fail';
  if (checks.some((c) => c.bucket === 'pending')) return args.waitedMs >= args.timeoutMs ? 'timeout' : 'pending';
  return 'pass';
}
