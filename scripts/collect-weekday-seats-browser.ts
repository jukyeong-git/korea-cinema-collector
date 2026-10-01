import { retryCollection } from '../src/core/retry-collection';
import { annotateError, checkReceiver } from '../src/core/error-details';
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
import { readStoredSeatPlan } from '../src/core/stored-seat-plan';
import { createDynamoDbSessionRepository } from '../src/platform/aws/dynamodb-session-repository';
import type { SeatCandidate } from '../src/core/types';


const {id: shard, weekday, name: weekdayName} = seatShard(process.env.SEAT_SHARD);
const scheduleSource = process.env.SEAT_SCHEDULE_SOURCE ?? 'cgv';
if (!['cgv', 'dynamodb'].includes(scheduleSource)) throw Error('Invalid seat schedule source');
if (scheduleSource === 'dynamodb' && !process.env.TABLE_NAME) throw Error('TABLE_NAME is required for stored schedules');
const repository = scheduleSource === 'dynamodb' ? createDynamoDbSessionRepository(process.env.TABLE_NAME!) : undefined;
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
let phase = 'browser_setup';
async function main() {
  phase = 'browser_setup';
  if (state.retryAt && state.retryAt > Date.now()) { console.log(JSON.stringify({event:'cooldown',retryAt:new Date(state.retryAt).toISOString()})); return; }
  if (Date.now() >= deadline) { console.log(JSON.stringify({event:'seats_complete',reason:'deadline during setup'})); return; }
  let browser: Browser | undefined;
  const endTimer = setTimeout(() => { void browser?.close().catch(()=>{}); }, deadline - Date.now());
  try {
    const browserOptions = {headless:false,geoip:shard === '01',locale:'ko-KR',
      ...(shard === '01' ? {humanize:true,disable_coop:true} : {})};
    console.log(JSON.stringify({event:'browser_options',shard,...browserOptions}));
    browser = await firefox.launch({...await launchOptions(browserOptions),timeout:Math.min(60_000,Math.max(1,deadline-Date.now()))});
    if (Date.now() >= deadline) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    const report = (event: object) => console.log(JSON.stringify(event));
    phase = 'navigation';
    await retryForbidden(async () => {
      const nav = await page.goto('https://cgv.co.kr/cnm/movieBook/cinema?siteNo=0013',{waitUntil:'domcontentloaded',timeout:30_000});
      if (nav && !nav.ok()) throw new CgvHttpError(nav.status(),nav.headers()['retry-after'] ?? null,'Navigation failed');
    }, {deadline,phase:'navigation',report});
    await sleep(5000);
    let stopped = false;
    const browserFetch: typeof fetch = async input => {
      if (stopped) throw Error('Collection stopped');
      const requestStart=Date.now();
      try {
        const result = await page.evaluate(async url => {
          const response = await fetch(url,{credentials:'include',signal:AbortSignal.timeout(15_000)});
          return {status:response.status,body:await response.text(),retryAfter:response.headers.get('retry-after')};
        },String(input));
        if (result.status >= 400) stopped = true;
        return new Response(result.body,{status:result.status,headers:result.retryAfter ? {'retry-after':result.retryAfter} : {}});
      } catch (e) {
        stopped = true;
        const url=new URL(String(input));
        throw annotateError(e,{phase,endpoint:url.pathname,date:url.searchParams.get('scnYmd') ?? undefined,
          session:url.searchParams.get('scnSseq') ?? undefined,durationMs:Date.now()-requestStart});
      }
    };
    let deliveredAt = 0, index = 0;
    while (!stopped && Date.now() < deadline) {
      const start = Date.now(); index++;
      let now = new Date();
      let candidates: SeatCandidate[];
      if (repository) {
        phase = 'stored_schedule';
        const plan = await readStoredSeatPlan(repository, weekday, now);
        candidates = plan.candidates;
        console.log(JSON.stringify({event:'seat_collection_plan',source:'dynamodb',shard,weekday:weekdayName,
          dates:plan.dates,candidates:candidates.length}));
      } else {
        phase = 'collection';
        const schedule = await retryForbidden(async () => {
          // fetchApiImaxSessions drains all in-flight requests before rejecting.
          // Restart the complete observation so no failed date is published as empty.
          stopped = false;
          return fetchApiImaxSessions({fetch:browserFetch,weekday});
        }, {deadline,phase:'collection',report});
        if (!schedule.seatCandidates || schedule.failedDates?.length) throw Error('Incomplete schedule');
        now = new Date();
        candidates = schedule.seatCandidates.filter(c => new Date(`${c.displayDate}T00:00:00Z`).getUTCDay() === weekday && performanceStart(c) > now.getTime());
      }
      phase = 'seats';
      const entries = await collectSeatObservation(candidates,
        async candidate => {
          const requestStart=Date.now();
          try { return {performanceId:candidate.performanceId,...await fetchPreferredSeats(candidate,undefined,browserFetch)}; }
          catch(error) { throw annotateError(error,{phase:'seats',endpoint:'/api/v1/booking/searchIfSeatData',date:candidate.displayDate,session:candidate.seatQuery.scnSseq,durationMs:Date.now()-requestStart}); }
        },
        {deadline,report,beforeAttempt:()=>{ stopped=false; }});
      const payload = makePayload(entries,now);
      try {
        phase = 'delivery';
        // Refresh eligibility and retry pending notifications even when availability is unchanged.
        const changed = await deliverTransfer(payload,Date.now()-deliveredAt >= 60_000 ? undefined : state.hash,async value => {
          const response = await lambda.send(new InvokeCommand({FunctionName:process.env.RECEIVER_FUNCTION!,
            InvocationType:'RequestResponse',Payload:Buffer.from(JSON.stringify({...value,dryRun}))}));
          return checkReceiver(response);
        },hash => save({version:1,hash,observedAt:now.toISOString()}),dryRun);
        if (changed) deliveredAt=Date.now();
        console.log(JSON.stringify({event:'seats_cycle',index,weekday:weekdayName,shard,sessions:payload.entries.length,
          changed,dryRun,durationMs:Date.now()-start,hash:payload.hash}));
      } catch (error) {
        throw annotateError(error,{phase:'delivery'});
      }
      if (Date.now() < deadline) await sleep(Math.max(0,Math.min(deadline,start+5_000)-Date.now()));
    }
  } catch (error) {
    if (Date.now() < deadline) throw error;
    console.log(JSON.stringify({event:'seats_complete',reason:'deadline'}));
  } finally { clearTimeout(endTimer); await browser?.close(); }
}
try { await retryCollection(main,{deadline,phase:()=>phase,report:event=>console.log(JSON.stringify(event))}); }
catch(error) {
  if (error instanceof CgvHttpError && error.retryAt && !dryRun) save({...state,retryAt:error.retryAt});
  console.error(JSON.stringify({event:'seats_stopped',status:error instanceof CgvHttpError ? error.status : undefined,
    retryAfter:error instanceof CgvHttpError ? error.retryAfter : undefined,reason:'Collection or delivery failed; prior state retained'}));
  process.exitCode=1;
}
