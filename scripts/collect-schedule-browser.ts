import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright-core';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { fetchApiImaxSessions, CgvHttpError } from '../src/collectors/cgv-api';
import { makeScheduleTransfer } from '../src/core/schedule-transfer';
import { deliverTransfer } from '../src/core/transfer-delivery';
import { retryForbidden } from '../src/core/retry-forbidden';
import { publishScheduleSnapshot } from '../src/platform/aws/schedule-snapshot';

type State = { version: 1; hash?: string; observedAt?: string; retryAt?: number };
const statePath = process.env.STATE_PATH ?? 'state/schedule.json';
let state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {version:1};
if (state.version !== 1 || (state.hash !== undefined && !/^[a-f0-9]{64}$/.test(state.hash))
  || (state.retryAt !== undefined && !Number.isFinite(state.retryAt))) throw Error('Invalid collector state');
const dryRun = process.env.DRY_RUN === 'true';
const duration = Number(process.env.DURATION_MINUTES ?? '60');
if (!Number.isInteger(duration) || duration < 1 || duration > 60) throw Error('Invalid duration');
const save = (next: State) => { state = next; writeFileSync(statePath, JSON.stringify(state) + '\n'); };
const lambda = new LambdaClient({ maxAttempts: 1 });
async function main() {
  if (state.retryAt && state.retryAt > Date.now()) { console.log(JSON.stringify({event:'cooldown',retryAt:new Date(state.retryAt).toISOString()})); return; }
  const browser = await firefox.launch({...await launchOptions({headless:false,geoip:false,locale:'ko-KR'}),timeout:60_000});
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const deadline = Date.now() + duration * 60_000;
    endTimer = setTimeout(() => { void browser.close().catch(()=>{}); }, duration * 60_000);
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
    let snapshotAt = 0, deliveryFailures = 0, index = 0;
    while (!stopped && Date.now() < deadline && index < duration * 4) {
      const start = Date.now(); index++;
      const schedule = await retryForbidden(async () => {
        // fetchApiImaxSessions drains all in-flight requests before rejecting.
        // Restart the complete observation so no failed date is published as empty.
        stopped = false;
        return fetchApiImaxSessions({fetch:browserFetch});
      }, {deadline,phase:'collection',report});
      const now = new Date();
      const payload = makeScheduleTransfer(schedule,now);
      try {
        // The seven AWS seat workers require a fresh candidate snapshot even if nothing changed.
        if (!dryRun && (Date.now()-snapshotAt >= 60_000 || state.hash !== payload.hash)) {
          await publishScheduleSnapshot(process.env.TABLE_NAME!,schedule,now);
          snapshotAt = Date.now();
        }
        const changed = await deliverTransfer(payload,state.hash,async value => {
          const response = await lambda.send(new InvokeCommand({FunctionName:process.env.RECEIVER_FUNCTION!,
            InvocationType:'RequestResponse',Payload:Buffer.from(JSON.stringify({...value,dryRun}))}));
          if (response.FunctionError || response.StatusCode !== 200 || !response.Payload) throw Error('Receiver failed');
          return JSON.parse(Buffer.from(response.Payload).toString());
        },hash => save({version:1,hash,observedAt:now.toISOString()}),dryRun);
        deliveryFailures=0;
        console.log(JSON.stringify({event:'schedule_cycle',index,dates:payload.dates.length,sessions:payload.sessions.length,
          changed,dryRun,durationMs:Date.now()-start,hash:payload.hash}));
      } catch {
        // Never print SDK exceptions, function identifiers or receiver error payloads.
        console.error(JSON.stringify({event:'delivery_failed',index,hashAcknowledged:false}));
        if (++deliveryFailures >= 3) throw Error('Repeated delivery failure');
      }
      if (index < duration*4) await sleep(Math.max(0,Math.min(deadline,start+15_000)-Date.now()));
    }
  } finally { if (endTimer) clearTimeout(endTimer); await browser.close(); }
}
try { await main(); }
catch(error) {
  if (error instanceof CgvHttpError && error.retryAt && !dryRun) save({...state,retryAt:error.retryAt});
  console.error(JSON.stringify({event:'schedule_stopped',status:error instanceof CgvHttpError ? error.status : undefined,
    retryAfter:error instanceof CgvHttpError ? error.retryAfter : undefined,reason:'Collection or delivery failed; prior state retained'}));
  process.exitCode=1;
}
