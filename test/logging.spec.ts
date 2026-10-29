import { expect, it, vi } from 'vitest';
import { report, finish } from '../src/logging/collector';
import { sanitizeLogValue } from '../src/logging/contract';
import { CgvHttpError } from '../src/collectors/cgv-api';
it('keeps structured diagnostics free of credentials, bodies and personal data', () => {
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try {
    report({event:'operation_failed', phase:'collection', status:429, authorization:'Bearer abc', body:'<html>secret</html>', reason:'token=secret', email:'a@example.com', phone:'+65 8123 4567', nested:{cookie:'abc'}});
    const output=log.mock.calls[0][0] as string;
    expect(JSON.parse(output)).toMatchObject({schemaVersion:1,country:'KR',status:'failed',error:{category:'http',httpStatus:429}});
    expect(output).not.toMatch(/abc|secret|example.com|8123/);
    const safe=JSON.stringify(sanitizeLogValue({token:'abc',body:'secret',email:'a@example.com',phone:'+65 8123 4567',ip:'192.168.0.1',v6:'2001:db8::1',exception:new Error('secret')}));
    expect(safe).not.toMatch(/abc|secret|example.com|8123|192\.168\.0\.1|2001:db8::1/);
    expect(new CgvHttpError(429, null, '<html>secret</html>').message).not.toContain('secret');
  } finally {log.mockRestore();}
});

it('emits collector summaries using shared contract levels', () => {
  const info = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    finish('complete'); finish('partial'); finish('failed');
    for (const [spy, status, level] of [[info, 'complete', 'INFO'], [warn, 'partial', 'WARN'], [error, 'failed', 'ERROR']] as const) {
      expect(JSON.parse(spy.mock.calls[0][0] as string)).toMatchObject({ schemaVersion: 1, event: 'run_summary', country: 'KR', city: 'Seoul', component: 'collector', operation: expect.any(String), runId: expect.any(String), durationMs: expect.any(Number), status, level });
    }
  } finally { info.mockRestore(); warn.mockRestore(); error.mockRestore(); }
});

it('records duration once while preserving other diagnostics', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    report({event:'phase_complete', durationMs:42, phase:'collection'});
    const row = JSON.parse(log.mock.calls[0][0] as string);
    expect(row.durationMs).toBe(42);
    expect(row.diagnostics).toEqual({phase:'collection'});
  } finally { log.mockRestore(); }
});
