import { setTimeout as sleep } from 'node:timers/promises';
import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright-core';
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
  async function attempt(phase: string, index: number) {
    const start = Date.now();
    const hasClearance = (await context.cookies('https://cgv.co.kr')).some(c => c.name === 'cf_clearance' && c.value.length > 0);
    try {
      const result = await fetchApiImaxSessions({ fetch: browserFetch });
      console.log(JSON.stringify({ event: 'collection', phase, index, at: new Date(start).toISOString(), hasClearance, ok: true,
        durationMs: Date.now() - start, dates: result.dates.length, sessions: result.sessions.length }));
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
  // Eleven collections maximum, preserving the previous 1 + 10 trial budget.
  // Start-to-start cadence; never overlap collections if one exceeds five seconds.
  if (throttled) process.exitCode = 1;
  for (let index = 1; index <= 11 && !throttled; index++) {
    const start = Date.now();
    if (!await attempt('five-second-validation', index)) {
      process.exitCode = 1;
      break;
    }
    if (index < 11) await sleep(Math.max(0, start + 5000 - Date.now()));
  }
} finally { await browser.close(); }
