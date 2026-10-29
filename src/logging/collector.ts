import { randomUUID } from 'node:crypto';
import { logRecovery, logSummary, type LogStatus } from './contract';
const runId = randomUUID(), started = Date.now();
const safeKeys = new Set(['date','dates','sessions','index','weekday','shard','changed','dryRun','phase','attempt','elapsedMs','retry','delayMs','retryAt','retryAfter','category','errorType','checked','failed','skipped','partial','maxAttempts','batch','systemInstall','code']);
export function report(input: object) {
  const row = input as Record<string, unknown>;
  const event = typeof row.event === 'string' && /^[a-z][a-z0-9_-]{0,80}$/.test(row.event) ? row.event : 'collector_diagnostic';
  const status: LogStatus = /failed|stopped/.test(event) ? 'failed' : /cooldown/.test(event) ? 'skipped' : row.partial === true ? 'partial' : 'complete';
  if (event === 'browser_session_restart' && row.retry === true) {
    logRecovery({event, country:'KR', city:'Seoul', component:'collector', operation:process.env.SEAT_SHARD ? 'seat_collection' : 'schedule_collection', runId, provider:'CGV', status:'complete', durationMs:Date.now()-started, diagnostics:{action:'browser_session_restart'}});
    return;
  }
  if (status === 'complete' || status === 'skipped') return;
  const diagnostics = Object.fromEntries(Object.entries(row).filter(([key, value]) => safeKeys.has(key) && (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' && (/^\d{4}-\d{2}-\d{2}(?:T[0-9:.]+Z)?$/.test(value) || /^(?:browser_setup|browser_release|navigation|collection|seats|delivery|snapshot_publish|schedule_date|calendar|timeout|network|json_parse|browser_closed|stale_schedule|validation|receiver|other|Error|TypeError|SyntaxError|TimeoutError|AbortError|StaleScheduleError|AccessDeniedException|ThrottlingException|ExpiredTokenException|ResourceNotFoundException|ProvisionedThroughputExceededException|OtherError|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|BROWSER_PREFLIGHT_FAILED|BROWSER_PREFLIGHT_FAILED_AFTER_INSTALL|SYSTEM_INSTALL_FAILED|PREPARE_FAILED)$/.test(value) || key === 'shard' && /^0[1-7]$/.test(value)))));
  logSummary({ event, country:'KR', city:'Seoul', component:'collector', operation:process.env.SEAT_SHARD ? 'seat_collection' : 'schedule_collection', runId, provider:'CGV', status, durationMs: typeof row.durationMs === 'number' ? row.durationMs : Date.now()-started, ...(typeof row.status === 'number' ? {error:{category:'http',httpStatus:row.status}} : {}), diagnostics });
}

export function finish(status: LogStatus) { logSummary({ event:'run_summary', country:'KR', city:'Seoul', component:'collector', operation:process.env.SEAT_SHARD ? 'seat_collection' : 'schedule_collection', runId, provider:'CGV', status, durationMs:Date.now()-started }); }
