import { setTimeout as sleep } from 'node:timers/promises';
import { CgvHttpError } from '../collectors/cgv-api';

// Ten attempts total per operation; a later 403 starts a new retry budget.
export async function retryForbidden<T>(operation: () => Promise<T>, options: {
  deadline: number;
  phase: 'navigation' | 'collection';
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
  report?: (event: { event: string; phase: string; attempt: number; maxAttempts: number }) => void;
}): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (now() >= options.deadline) throw Error('Collection duration reached');
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof CgvHttpError) || error.status !== 403) throw error;
      options.report?.({event:'cgv_403_attempt_failed',phase:options.phase,attempt,maxAttempts:10});
      if (attempt === 10 || now() + 5000 >= options.deadline) throw error;
      await wait(5000);
    }
  }
  throw Error('Unreachable retry state');
}
