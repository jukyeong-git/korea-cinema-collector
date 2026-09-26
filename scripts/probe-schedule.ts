import { setTimeout as sleep } from 'node:timers/promises';
import { CgvHttpError, fetchApiImaxSessions } from '../src/collectors/cgv-api';

// Read-only experiment: no AWS, state persistence, cookies or notifications.
async function attempt(phase: string, index: number) {
  const start = Date.now();
  try {
    const result = await fetchApiImaxSessions();
    console.log(JSON.stringify({ phase, index, at: new Date(start).toISOString(), ok: true,
      durationMs: Date.now() - start, dates: result.dates.length, sessions: result.sessions.length }));
    return true;
  } catch (error) {
    console.log(JSON.stringify({ phase, index, at: new Date(start).toISOString(), ok: false,
      durationMs: Date.now() - start,
      status: error instanceof CgvHttpError ? error.status : undefined,
      retryAfter: error instanceof CgvHttpError ? error.retryAfter : undefined,
      error: error instanceof Error ? error.message : String(error) }));
    // Respect explicit server throttling; never retry a 429 in this probe.
    if (error instanceof CgvHttpError && (error.status === 429 || error.retryAfter)) throw error;
    return false;
  }
}
let success = false;
for (let index = 1; index <= 10; index++) {
  const start = Date.now();
  if (await attempt('initial', index)) { success = true; break; }
  if (index < 10) await sleep(Math.max(0, start + 5000 - Date.now()));
}
if (!success) {
  console.log('No successful full collection in 10 attempts; stopping.');
  process.exitCode = 1;
} else {
  for (let index = 1; index <= 10; index++) {
    await sleep(60_000);
    await attempt('minute-validation', index);
  }
}
