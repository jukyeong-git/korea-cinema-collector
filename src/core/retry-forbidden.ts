import { setTimeout as sleep } from 'node:timers/promises';
import { CgvHttpError } from '../collectors/cgv-api';

// The owner closes the browser in finally before retryCollection starts a new one.
export class BrowserSessionRestartError extends Error {
  constructor(readonly phase: string) { super('Restart browser after ten forbidden attempts'); }
}
// Each browser session receives at most ten consecutive forbidden attempts per operation.
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
      if (attempt === 10) {
        options.report?.({event:'cgv_403_session_exhausted',phase:options.phase,attempt,maxAttempts:10,batch});
        throw new BrowserSessionRestartError(options.phase);
      }
      const delayMs = 5000;
      if (now() + delayMs >= options.deadline) throw error;
      await wait(delayMs);
      attempt++;
    }
  }
}
