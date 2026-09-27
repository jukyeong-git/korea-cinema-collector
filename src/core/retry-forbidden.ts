import { setTimeout as sleep } from 'node:timers/promises';
import { CgvHttpError } from '../collectors/cgv-api';

// Repeat ten-attempt batches until success or the overall collection deadline.
export async function retryForbidden<T>(operation: () => Promise<T>, options: {
  deadline: number;
  phase: 'navigation' | 'collection' | 'seats';
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
  report?: (event: { event: string; phase: string; attempt: number; maxAttempts: number; batch: number; delayMs?: number }) => void;
}): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  let attempt = 1, batch = 1;
  while (true) {
    if (now() >= options.deadline) throw Error('Collection duration reached');
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof CgvHttpError) || error.status !== 403) throw error;
      options.report?.({event:'cgv_403_attempt_failed',phase:options.phase,attempt,maxAttempts:10,batch});
      const delayMs = attempt === 10 ? 10000 : 5000;
      if (now() + delayMs >= options.deadline) throw error;
      if (attempt === 10) {
        options.report?.({event:'cgv_403_batch_wait',phase:options.phase,attempt,maxAttempts:10,batch,delayMs});
      }
      await wait(delayMs);
      if (attempt === 10) { attempt = 1; batch++; } else { attempt++; }
    }
  }
}
