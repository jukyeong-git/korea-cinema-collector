// Only allowlisted diagnostics enter public workflow logs; never raw messages,
// bodies, headers, SDK exceptions, stacks, resource identifiers or credentials.
export type ErrorContext = {phase?: string; endpoint?: string; date?: string; session?: string; durationMs?: number};
const contexts = new WeakMap<object, ErrorContext>();
export function annotateError(error: unknown, context: ErrorContext) {
  if (error && typeof error === 'object') contexts.set(error,{...context,...contexts.get(error)});
  return error;
}
export class StaleScheduleError extends Error { constructor() { super('Missing or stale DynamoDB schedule snapshot'); this.name='StaleScheduleError'; } }
export function errorDetails(error: unknown) {
  const e = error as {name?: string; message?: string; status?: number; $metadata?: {httpStatusCode?: number}} | null;
  const text = String(e?.message ?? '');
  const category = /timeout|timed out|aborted due to timeout/i.test(text) || e?.name==='TimeoutError' ? 'timeout'
    : /fetch|network|ECONN|ENOTFOUND|socket/i.test(text) ? 'network'
    : /JSON|Unexpected token|Unexpected end/i.test(text) || e?.name==='SyntaxError' ? 'json_parse'
    : /closed|crashed|disconnected/i.test(text) ? 'browser_closed'
    : /stale DynamoDB schedule snapshot/.test(text) ? 'stale_schedule'
    : /invalid|malformed|missing|unexpected|incomplete|unknown/i.test(text) ? 'validation'
    : /receiver|acknowledge/i.test(text) ? 'receiver'
    : /release/i.test(text) ? 'browser_release' : 'other';
  const types=['Error','TypeError','SyntaxError','TimeoutError','AbortError','StaleScheduleError','AccessDeniedException','ThrottlingException','ExpiredTokenException','ResourceNotFoundException','ProvisionedThroughputExceededException'];
  const status=e?.status ?? e?.$metadata?.httpStatusCode;
  return {category,errorType:types.includes(e?.name ?? '')?e!.name:'OtherError',
    message:({timeout:'Request exceeded its time limit',network:'Network request failed',json_parse:'Response JSON could not be parsed',browser_closed:'Browser or page was closed',stale_schedule:'Missing or stale DynamoDB schedule snapshot',validation:'Response or payload validation failed',receiver:'Receiver failed or did not acknowledge',browser_release:'Browser release lookup failed',other:'Unexpected operation failure'})[category],
    ...(Number.isInteger(status)?{status}:{}),
    ...(error && typeof error==='object'?contexts.get(error):{})};
}
export function checkReceiver(response: {FunctionError?: string; StatusCode?: number; Payload?: Uint8Array}) {
  let payload: any;
  if(response.Payload) {
    try { payload=JSON.parse(Buffer.from(response.Payload).toString()); }
    catch { throw Error('Invalid receiver JSON'); }
  }
  if(response.FunctionError) {
    if(payload?.errorMessage==='Missing or stale DynamoDB schedule snapshot') throw new StaleScheduleError();
    throw Error('Receiver function failed');
  }
  if(response.StatusCode!==200 || !payload) throw Error('Receiver failed');
  return payload;
}
