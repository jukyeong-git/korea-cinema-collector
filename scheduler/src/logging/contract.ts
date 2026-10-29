/** Shared log contract, vendored across independent country repositories. */
export type LogStatus = 'complete' | 'partial' | 'failed' | 'skipped';
export interface LogRecord {
  event: string; country: string; city: string; component: string; operation: string;
  runId: string; status: LogStatus; durationMs: number;
  provider?: string; correlationId?: string;
  counts?: { requestsAttempted?: number; requestsSucceeded?: number; requestsFailed?: number; requestsUnprocessed?: number; notificationsSent?: number };
  error?: { category: string; code?: string; httpStatus?: number };
  diagnostics?: Record<string, unknown>;
}
const SECRET_KEY = /authorization|cookie|password|secret|token|api.?key|credential|signature|session(?:id|key|secret|token)|^session$|booking|encrypted|body|email|phone|ipaddress/i;
/** Conservatively omit bodies and HTML; redact identifiers and credentials recursively. */
export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[OMITTED]';
  if (value instanceof Error) return { category: safeError(value).category, bodyOmitted: true };
  if (typeof value === 'string') {
    if (/<\/?[a-z!][^>]*>/i.test(value)) return '[OMITTED]';
    if (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) return value;
    return value.replace(/https?:\/\/[^\s"']+/gi, '[URL REDACTED]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[REDACTED]')
      .replace(/\b\d{5,}:\w{15,}\b/g, '[REDACTED]')
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[REDACTED]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED]')
      .replace(/\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]{1,}\b/gi, '[REDACTED]')
      .replace(/(?<!\w)\+?\d[\d ()-]{7,}\d(?!\w)/g, '[REDACTED]')
      .replace(/\b(?:authorization|cookie|password|secret|token|api.?key|credential|signature|encrypted|booking)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
      .slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeLogValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, (key === 'bodyOmitted' || key === 'bodyTruncated') && typeof item === 'boolean' ? item : key === 'bodyReadError' && typeof item === 'string' && /^[A-Za-z][A-Za-z0-9]{0,80}$/.test(item) ? item : SECRET_KEY.test(key) ? '[REDACTED]' : sanitizeLogValue(item, depth + 1)]));
  return value;
}
/** Bodies are intentionally omitted; callers may supply safe scalar diagnostics. */
export function logSummary(record: LogRecord): void {
  const level = record.status === 'failed' ? (record.event === 'request_failed' ? 'WARN' : 'ERROR') : record.status === 'partial' ? 'WARN' : 'INFO';
  const entry = { schemaVersion: 1, timestamp: new Date().toISOString(), level, ...(sanitizeLogValue(record) as LogRecord) };
  (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(JSON.stringify(entry));
}
/** Do not expose untrusted error names, messages, response bodies, URLs or stack traces. */
export function safeError(error: unknown): { category: string } {
  const name = error instanceof Error ? error.name : '';
  return { category: /^[A-Za-z][A-Za-z0-9]{0,80}$/.test(name) ? name : 'Error' };
}
