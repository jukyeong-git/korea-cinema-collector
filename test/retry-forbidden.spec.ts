import { expect, it, vi } from 'vitest';
import { retryForbidden } from '../src/core/retry-forbidden';
import { CgvHttpError } from '../src/collectors/cgv-api';
const forbidden = () => new CgvHttpError(403,null,'blocked');
it('retries 403 ten times total with nine five-second waits', async () => {
  const operation=vi.fn().mockRejectedValue(forbidden()), wait=vi.fn().mockResolvedValue(undefined);
  await expect(retryForbidden(operation,{deadline:100000,now:()=>0,wait,phase:'navigation'})).rejects.toThrow('403');
  expect(operation).toHaveBeenCalledTimes(10); expect(wait).toHaveBeenCalledTimes(9);
  expect(wait.mock.calls.every(([ms])=>ms===5000)).toBe(true);
});
it('recovers and grants a fresh budget for a later collection', async () => {
  const operation=vi.fn().mockRejectedValueOnce(forbidden()).mockResolvedValueOnce('ok').mockRejectedValueOnce(forbidden()).mockResolvedValue('next');
  const options={deadline:100000,now:()=>0,wait:vi.fn().mockResolvedValue(undefined),phase:'collection' as const};
  expect(await retryForbidden(operation,options)).toBe('ok');
  expect(await retryForbidden(operation,options)).toBe('next');
  expect(options.wait).toHaveBeenCalledTimes(2);
});
it('does not retry 429 or exceed the collection deadline', async () => {
  const wait=vi.fn(), limited=vi.fn().mockRejectedValue(new CgvHttpError(429,'1800','limited'));
  await expect(retryForbidden(limited,{deadline:100000,now:()=>0,wait,phase:'collection'})).rejects.toThrow('429');
  const blocked=vi.fn().mockRejectedValue(forbidden());
  await expect(retryForbidden(blocked,{deadline:4000,now:()=>0,wait,phase:'collection'})).rejects.toThrow('403');
  expect(limited).toHaveBeenCalledTimes(1);expect(blocked).toHaveBeenCalledTimes(1);expect(wait).not.toHaveBeenCalled();
});
