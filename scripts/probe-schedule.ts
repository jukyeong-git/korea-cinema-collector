import { setTimeout as sleep } from 'node:timers/promises';
import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright-core';
import { CgvHttpError, fetchApiImaxSessions } from '../src/collectors/cgv-api';

// Browser and cookies are ephemeral: never export profiles, cookies or tokens.
const browser = await firefox.launch({ ...await launchOptions({ headless: false, geoip: false, locale: 'ko-KR' }), timeout: 60_000 });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = 'https://cgv.co.kr/cnm/movieBook/cinema?siteNo=0013';
  let cleared = false;
  for (let index = 1; index <= 10; index++) {
    const start = Date.now();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      if (response?.status() === 429) {
        console.log(JSON.stringify({ event: 'navigation_throttled', status: 429 }));
        process.exitCode = 1;
        break;
      }
    } catch { console.log(JSON.stringify({ event: 'navigation_incomplete', index })); }
    // Allow the page challenge to finish instead of interrupting it with reloads.
    await sleep(Math.max(0, start + 5000 - Date.now()));
    cleared = (await context.cookies('https://cgv.co.kr')).some(c => c.name === 'cf_clearance' && c.value.length > 0);
    console.log(JSON.stringify({ event: 'clearance_attempt', index, at: new Date().toISOString(), hasClearance: cleared }));
    if (cleared) break;
  }
  if (!cleared) {
    console.log('No clearance cookie after 10 attempts; stopping.');
    process.exitCode = 1;
  } else {
    // Browser fetch preserves its real User-Agent, TLS stack and session cookies.
    const browserFetch: typeof fetch = async input => {
      const result = await page.evaluate(async requestUrl => {
        const response = await fetch(requestUrl, { credentials: 'include', signal: AbortSignal.timeout(15_000) });
        return { status: response.status, body: await response.text(), retryAfter: response.headers.get('retry-after') };
      }, String(input));
      return new Response(result.body, { status: result.status,
        headers: result.retryAfter ? { 'retry-after': result.retryAfter } : {} });
    };
    for (let index = 1; index <= 10; index++) {
      const start = Date.now();
      try {
        const result = await fetchApiImaxSessions({ fetch: browserFetch });
        console.log(JSON.stringify({ event: 'collection', index, at: new Date(start).toISOString(), ok: true,
          durationMs: Date.now() - start, dates: result.dates.length, sessions: result.sessions.length }));
      } catch (error) {
        process.exitCode = 1;
        console.log(JSON.stringify({ event: 'collection', index, ok: false, durationMs: Date.now() - start,
          status: error instanceof CgvHttpError ? error.status : undefined,
          retryAfter: error instanceof CgvHttpError ? error.retryAfter : undefined,
          error: error instanceof CgvHttpError ? 'CGV HTTP error' : 'Request or validation failed' }));
        if (error instanceof CgvHttpError && (error.status === 429 || error.retryAfter)) {
          process.exitCode = 1;
          break;
        }
      }
      if (index < 10) await sleep(Math.max(0, start + 60_000 - Date.now()));
    }
  }
} finally { await browser.close(); }
