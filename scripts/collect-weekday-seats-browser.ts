import { seatShard } from '../src/core/seat-shards';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { launchOptions } from 'camoufox-js';
import { firefox, type Browser } from 'playwright-core';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { fetchApiImaxSessions, CgvHttpError } from '../src/collectors/cgv-api';
import { makePayload } from '../src/core/monday-seat-payload';
import { fetchPreferredSeats } from '../src/collectors/monday-seats';
import { performanceStart } from '../src/core/seat-monitor';
import { deliverTransfer } from '../src/core/transfer-delivery';
import { retryForbidden } from '../src/core/retry-forbidden';
import { collectSeatObservation } from '../src/core/collect-seat-observation';


const {id: shard, weekday, name: weekdayName} = seatShard(process.env.SEAT_SHARD);
type State = { version: 1; hash?: string; observedAt?: string; retryAt?: number };
const statePath = process.env.STATE_PATH ?? `state/seats-${shard}.json`;
let state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {version:1};
if (state.version !== 1 || (state.hash !== undefined && !/^[a-f0-9]{64}$/.test(state.hash))
  || (state.retryAt !== undefined && !Number.isFinite(state.retryAt))) throw Error('Invalid collector state');
const dryRun = process.env.DRY_RUN === 'true';
const deadline = Number(process.env.COLLECTOR_END_AT);
if (!Number.isFinite(deadline) || deadline <= 0 || deadline > Date.now() + 59.5 * 60_000) throw Error('Invalid session deadline');
const save = (next: State) => { state = next; writeFileSync(statePath, JSON.stringify(state) + '\n'); };
const lambda = new LambdaClient({ maxAttempts: 1 });
async function main() {
  if (state.retryAt && state.retryAt > Date.now()) { console.log(JSON.stringify({event:'cooldown',retryAt:new Date(state.retryAt).toISOString()})); return; }
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
    const browserFetch: typeof fetch = async input => {
      if (stopped) throw Error('Collection stopped');
      try {
        const result = await page.evaluate(async url => {
          const response = await fetch(url,{credentials:'include',signal:AbortSignal.timeout(15_000)});
          return {status:response.status,body:await response.text(),retryAfter:response.headers.get('retry-after')};
        },String(input));
        if (result.status >= 400) stopped = true;
        return new Response(result.body,{status:result.status,headers:result.retryAfter ? {'retry-after':result.retryAfter} : {}});
      } catch (e) { stopped = true; throw e; }
    };
    let deliveredAt = 0, deliveryFailures = 0, index = 0;
    while (!stopped && Date.now() < deadline) {
      const start = Date.now(); index++;
      const schedule = await retryForbidden(async () => {
        // fetchApiImaxSessions drains all in-flight requests before rejecting.
        // Restart the complete observation so no failed date is published as empty.
        stopped = false;
        return fetchApiImaxSessions({fetch:browserFetch,weekday});
      }, {deadline,phase:'collection',report});
      if (!schedule.seatCandidates || schedule.failedDates?.length) throw Error('Incomplete schedule');
      const now = new Date();
      const candidates = schedule.seatCandidates.filter(c => new Date(`${c.displayDate}T00:00:00Z`).getUTCDay() === weekday && performanceStart(c) > now.getTime());
      const entries = await collectSeatObservation(candidates,
        async candidate => ({performanceId:candidate.performanceId,
          ...await fetchPreferredSeats(candidate,undefined,browserFetch)}),
        {deadline,report,beforeAttempt:()=>{ stopped=false; }});
      const payload = makePayload(entries,now);
      try {
        // Refresh eligibility and retry pending notifications even when availability is unchanged.
        const changed = await deliverTransfer(payload,Date.now()-deliveredAt >= 60_000 ? undefined : state.hash,async value => {
          const response = await lambda.send(new InvokeCommand({FunctionName:process.env.RECEIVER_FUNCTION!,
            InvocationType:'RequestResponse',Payload:Buffer.from(JSON.stringify({...value,dryRun}))}));
          if (response.FunctionError || response.StatusCode !== 200 || !response.Payload) throw Error('Receiver failed');
          return JSON.parse(Buffer.from(response.Payload).toString());
        },hash => save({version:1,hash,observedAt:now.toISOString()}),dryRun);
        deliveryFailures=0; if (changed) deliveredAt=Date.now();
        console.log(JSON.stringify({event:'seats_cycle',index,weekday:weekdayName,shard,sessions:payload.entries.length,
          changed,dryRun,durationMs:Date.now()-start,hash:payload.hash}));
      } catch {
        // Never print SDK exceptions, function identifiers or receiver error payloads.
        console.error(JSON.stringify({event:'delivery_failed',index,hashAcknowledged:false}));
        if (++deliveryFailures >= 3) throw Error('Repeated delivery failure');
      }
      if (Date.now() < deadline) await sleep(Math.max(0,Math.min(deadline,start+5_000)-Date.now()));
    }
  } catch (error) {
    if (Date.now() < deadline) throw error;
    console.log(JSON.stringify({event:'seats_complete',reason:'deadline'}));
  } finally { clearTimeout(endTimer); await browser?.close(); }
}
try { await main(); }
catch(error) {
  if (error instanceof CgvHttpError && error.retryAt && !dryRun) save({...state,retryAt:error.retryAt});
  console.error(JSON.stringify({event:'seats_stopped',status:error instanceof CgvHttpError ? error.status : undefined,
    retryAfter:error instanceof CgvHttpError ? error.retryAfter : undefined,reason:'Collection or delivery failed; prior state retained'}));
  process.exitCode=1;
}
