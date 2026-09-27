import { CgvHttpError } from '../collectors/cgv-api';
import { retryForbidden } from './retry-forbidden';

// Retry a complete observation only after every in-flight request has settled.
// Partial observations must never become the next seat baseline.
export async function collectSeatObservation<T, R>(candidates: T[], fetchSeat: (candidate: T) => Promise<R>,
  options: Omit<Parameters<typeof retryForbidden>[1], 'phase'> & { beforeAttempt?: () => void }): Promise<R[]> {
  return retryForbidden(async () => {
    options.beforeAttempt?.();
    let stopped = false, next = 0;
    const entries: R[] = new Array(candidates.length);
    const results = await Promise.allSettled(Array.from({length:Math.min(5,candidates.length)}, async () => {
      while (!stopped && next < candidates.length) {
        const index = next++;
        try { entries[index] = await fetchSeat(candidates[index]); }
        catch (error) { stopped = true; throw error; }
      }
    }));
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (errors.length) {
      // A concurrent 429 must take precedence over 403 and never be retried.
      throw errors.find(r => r.reason instanceof CgvHttpError && r.reason.status === 429)?.reason
        ?? errors.find(r => r.reason instanceof CgvHttpError && r.reason.status === 403)?.reason
        ?? errors[0].reason;
    }
    return entries;
  }, {...options,phase:'seats'});
}
