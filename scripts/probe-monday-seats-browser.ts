import { seatShard } from '../src/core/seat-shards';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchOptions } from 'camoufox-js';
import { firefox, type Browser } from 'playwright-core';
import { fetchApiImaxSessions, CgvHttpError } from '../src/collectors/cgv-api';
import { makePayload } from '../src/core/monday-seat-payload';
import { fetchPreferredSeats } from '../src/collectors/monday-seats';
import { performanceStart } from '../src/core/seat-monitor';
import { retryForbidden } from '../src/core/retry-forbidden';


const {id: shard, weekday, name: weekdayName} = seatShard('01');
const deadline = Number(process.env.COLLECTOR_END_AT);
if (!Number.isFinite(deadline) || deadline <= 0 || deadline > Date.now() + 59.5 * 60_000) throw Error('Invalid session deadline');
async function main() {
  if (Date.now() >= deadline) { console.log(JSON.stringify({event:'seats_complete',reason:'deadline during setup'})); return; }
  let browser: Browser | undefined;
  const endTimer = setTimeout(() => { void browser?.close().catch(()=>{}); }, deadline - Date.now());
  try {
    browser = await firefox.launch({...await launchOptions({headless:false,geoip:false,locale:'ko-KR'}),timeout:Math.min(60_000,Math.max(1,deadline-Date.now()))});
    if (Date.now() >= deadline) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    const report = (event: object) => console.log(JSON.stringify(event));
    await retryForbidden(async () => {
      const nav = await page.goto('https://cgv.co.kr/cnm/movieBook/cinema?siteNo=0013',{waitUntil:'domcontentloaded',timeout:30_000});
      if (nav && !nav.ok()) throw new CgvHttpError(nav.status(),nav.headers()['retry-after'] ?? null,'Navigation failed');
    }, {deadline,phase:'navigation',report});
    await sleep(5000);
    let stopped = false;
    let apiRequests = 0;
    const browserFetch: typeof fetch = async input => {
      if (stopped) throw Error('Collection stopped');
      try {
        apiRequests++;
        const result = await page.evaluate(async url => {
          const response = await fetch(url,{credentials:'include',signal:AbortSignal.timeout(15_000)});
          return {status:response.status,body:await response.text(),retryAfter:response.headers.get('retry-after')};
        },String(input));
        if (result.status >= 400) stopped = true;
        return new Response(result.body,{status:result.status,headers:result.retryAfter ? {'retry-after':result.retryAfter} : {}});
      } catch (e) { stopped = true; throw e; }
    };
    let index = 0;
    let previousHash: string | undefined;
    while (!stopped && Date.now() < deadline) {
      const start = Date.now(); index++;
      const requestsBefore = apiRequests;
      const schedule = await retryForbidden(async () => {
        // fetchApiImaxSessions drains all in-flight requests before rejecting.
        // Restart the complete observation so no failed date is published as empty.
        stopped = false;
        return fetchApiImaxSessions({fetch:browserFetch,weekday});
      }, {deadline,phase:'collection',report});
      if (!schedule.seatCandidates || schedule.failedDates?.length) throw Error('Incomplete schedule');
      const now = new Date();
      const candidates = schedule.seatCandidates.filter(c => new Date(`${c.displayDate}T00:00:00Z`).getUTCDay() === weekday && performanceStart(c) > now.getTime());
      const entries: import('../src/core/monday-seat-payload').SeatEntry[] = [];
      let next = 0;
      const results = await Promise.allSettled(Array.from({length:Math.min(5,candidates.length)},async () => {
        while (!stopped && next < candidates.length) {
          const candidate = candidates[next++];
          try { entries.push({performanceId:candidate.performanceId,...await fetchPreferredSeats(candidate,undefined,browserFetch)}); }
          catch (error) { stopped=true; throw error; }
        }
      }));
      const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (errors.length) throw errors.find(r => r.reason instanceof CgvHttpError && r.reason.status === 429)?.reason ?? errors[0].reason;
      if (stopped || entries.length !== candidates.length) throw Error('Incomplete seat observation');
      const payload = makePayload(entries,now);
      console.log(JSON.stringify({event:'seats_probe_cycle',index,weekday:weekdayName,shard,
        sessions:entries.length,dates:schedule.dates,changed:previousHash !== payload.hash,
        apiRequests:apiRequests-requestsBefore,totalApiRequests:apiRequests,
        durationMs:Date.now()-start,intervalMs:10_000,hash:payload.hash}));
      previousHash = payload.hash;
      if (Date.now() < deadline) await sleep(Math.max(0,Math.min(deadline,start+10_000)-Date.now()));
    }
  } catch (error) {
    if (Date.now() < deadline) throw error;
    console.log(JSON.stringify({event:'seats_complete',reason:'deadline'}));
  } finally { clearTimeout(endTimer); await browser?.close(); }
}
try { await main(); }
catch(error) {
  console.error(JSON.stringify({event:'seats_stopped',status:error instanceof CgvHttpError ? error.status : undefined,
    retryAfter:error instanceof CgvHttpError ? error.retryAfter : undefined,reason:'Probe collection failed; no state or notifications written'}));
  process.exitCode=1;
}
