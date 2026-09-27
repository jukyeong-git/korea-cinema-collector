import { expect, it, vi } from 'vitest';
import { retryForbidden } from '../src/core/retry-forbidden';
import { CgvHttpError } from '../src/collectors/cgv-api';
const forbidden = () => new CgvHttpError(403,null,'blocked');
it.each(['navigation','collection','seats'] as const)('restarts a failed batch after ten seconds for %s', async phase => {
  let time=0, calls=0;
  const wait=vi.fn(async(ms:number)=>{time+=ms;});
  const operation=vi.fn(async()=>{if(++calls<=20)throw forbidden();return 'ok';});
  const report=vi.fn();
  expect(await retryForbidden(operation,{deadline:200000,now:()=>time,wait,phase,report})).toBe('ok');
  expect(operation).toHaveBeenCalledTimes(21);
  expect(wait.mock.calls.map(([ms])=>ms)).toEqual([...Array(9).fill(5000),10000,...Array(9).fill(5000),10000]);
  expect(report.mock.calls.filter(([e])=>e.event==='cgv_403_batch_wait').map(([e])=>e.batch)).toEqual([1,2]);
});
it('stops persistent 403 before a batch wait would exceed the deadline',async()=>{
  let time=0;
  const operation=vi.fn().mockRejectedValue(forbidden()),wait=vi.fn(async(ms:number)=>{time+=ms;});
  await expect(retryForbidden(operation,{deadline:55000,now:()=>time,wait,phase:'seats'})).rejects.toThrow('403');
  expect(operation).toHaveBeenCalledTimes(10);expect(wait).toHaveBeenCalledTimes(9);
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
