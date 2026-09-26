import { setTimeout as sleep } from 'node:timers/promises';
import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright-core';
import { fetchPreferredSeats } from './probe-seat-parser';
import { CgvHttpError, fetchApiImaxSessions } from '../src/collectors/cgv-api';

// No AWS, notifications, persisted profiles or cookie values in logs.
const browser = await firefox.launch({ ...await launchOptions({ headless: false, geoip: false, locale: 'ko-KR' }), timeout: 60_000 });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  let throttled = false;
  try {
    const response = await page.goto('https://cgv.co.kr/cnm/movieBook/cinema?siteNo=0013', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const retryAfter = response?.headers()['retry-after'];
    console.log(JSON.stringify({ event: 'navigation', status: response?.status(), retryAfter }));
    throttled = Boolean(response && !response.ok()) || Boolean(retryAfter);
  } catch { throttled = true; console.log(JSON.stringify({ event: 'navigation_incomplete' })); }
  await sleep(5000);
  const browserFetch: typeof fetch = async input => {
    if (throttled) throw Error('Probe stopped after an error');
    const result = await page.evaluate(async requestUrl => {
      const response = await fetch(requestUrl, { credentials: 'include', signal: AbortSignal.timeout(15_000) });
      return { status: response.status, body: await response.text(), retryAfter: response.headers.get('retry-after'), contentType: response.headers.get('content-type') };
    }, String(input));
    if (result.status >= 400 || result.retryAfter) throttled = true;
    console.log(JSON.stringify({ event: 'api_response', endpoint: new URL(String(input)).pathname,
      status: result.status, contentType: result.contentType, retryAfter: result.retryAfter }));
    return new Response(result.body, { status: result.status,
      headers: result.retryAfter ? { 'retry-after': result.retryAfter } : {} });
  };
  const previous = new Map<string, string[]>();
  async function attempt(phase: string, index: number) {
    const start = Date.now();
    const hasClearance = (await context.cookies('https://cgv.co.kr')).some(c => c.name === 'cf_clearance' && c.value.length > 0);
    try {
      const result = await fetchApiImaxSessions({ fetch: browserFetch });
      if (!result.seatCandidates) throw Error('Missing seat candidates');
      const candidates = result.seatCandidates;
      const collected = new Map<string, string[]>();
      let next = 0;
      let firstError: unknown;
      const workers = await Promise.allSettled(Array.from({ length: Math.min(5, candidates.length) }, async () => {
        while (!throttled && next < candidates.length) {
          const candidate = candidates[next++];
          try {
            const snapshot = await fetchPreferredSeats(candidate, undefined, browserFetch);
            collected.set(candidate.performanceId, snapshot.available);
            const before = previous.get(candidate.performanceId);
            console.log(JSON.stringify({ event: 'seat_observation', index, date: candidate.displayDate,
              time: candidate.displayTime, title: candidate.title, available: snapshot.available,
              baseline: before === undefined, opened: before ? snapshot.available.filter(s => !before.includes(s)) : [],
              closed: before ? before.filter(s => !snapshot.available.includes(s)) : [] }));
          } catch (error) {
            firstError ??= error;
            throttled = true;
            console.log(JSON.stringify({ event: 'seat_failed', index, date: candidate.displayDate,
              time: candidate.displayTime, status: error instanceof CgvHttpError ? error.status : undefined }));
          }
        }
      }));
      if (firstError) throw firstError;
      const rejected = workers.find(w => w.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      if (throttled || collected.size !== candidates.length) throw Error('Incomplete seat collection');
      // Commit this in-memory baseline only after every target was validated.
      previous.clear();
      for (const [id, labels] of collected) previous.set(id, labels);
      console.log(JSON.stringify({ event: 'collection', phase, index, at: new Date(start).toISOString(), hasClearance, ok: true,
        durationMs: Date.now() - start, dates: result.dates.length, sessions: result.sessions.length,
        seatSessions: collected.size, availablePreferredSeats: [...collected.values()].reduce((n, a) => n + a.length, 0) }));
      return true;
    } catch (error) {
      console.log(JSON.stringify({ event: 'collection', phase, index, hasClearance, ok: false, durationMs: Date.now() - start,
        status: error instanceof CgvHttpError ? error.status : undefined,
        retryAfter: error instanceof CgvHttpError ? error.retryAfter : undefined,
        error: error instanceof CgvHttpError ? 'CGV HTTP error' : 'Request or validation failed' }));
      throttled = true;
      return false;
    }
  }
  // Bounded one-hour trial; at most 240 collections.
  // Start-to-start cadence; never overlap collections if one exceeds fifteen seconds.
  if (throttled) process.exitCode = 1;
  const deadline = Date.now() + 60 * 60_000;
  console.log(JSON.stringify({ event: "probe_started", deadline: new Date(deadline).toISOString(), intervalMs: 15000, maxCollections: 240 }));
  const deadlineTimer = setTimeout(() => { void browser.close().catch(() => {}); }, 60 * 60_000);
  try {
  for (let index = 1; index <= 240 && !throttled && Date.now() < deadline; index++) {
    const start = Date.now();
    if (!await attempt('seats-fifteen-second-validation', index)) {
      process.exitCode = 1;
      break;
    }
    if (index < 240 && !throttled) await sleep(Math.max(0, Math.min(deadline, start + 15000) - Date.now()));
  }
  } finally { clearTimeout(deadlineTimer); }
  if (throttled) process.exitCode = 1;
  console.log(JSON.stringify({ event: "probe_finished", stoppedOnError: throttled }));
} finally { await browser.close(); }
