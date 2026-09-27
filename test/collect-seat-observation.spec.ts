import { expect, it, vi } from 'vitest';
import { collectSeatObservation } from '../src/core/collect-seat-observation';
import { CgvHttpError } from '../src/collectors/cgv-api';
const blocked = () => new CgvHttpError(403,null,'blocked');
function options() { return {deadline:100000,now:()=>0,wait:vi.fn().mockResolvedValue(undefined)}; }
it('drains in-flight calls and replaces the entire partial observation after 403', async () => {
  const o=options(); let attempt=0,active=0;
  const beforeAttempt=()=>{expect(active).toBe(0);attempt++;};
  const fetch=vi.fn(async (id:number)=>{
    active++;
    await Promise.resolve();
    active--;
    if(attempt===1 && id===1)throw blocked();
    return `${attempt}:${id}`;
  });
  expect(await collectSeatObservation([1,2,3],fetch,{...o,beforeAttempt})).toEqual(['2:1','2:2','2:3']);
  expect(o.wait).toHaveBeenCalledWith(5000);
  expect(fetch).toHaveBeenCalledTimes(6);
});
it('limits persistent seat 403 to ten total attempts and nine waits',async()=>{
  const o=options(),fetch=vi.fn().mockRejectedValue(blocked());
  await expect(collectSeatObservation([1],fetch,o)).rejects.toThrow('403');
  expect(fetch).toHaveBeenCalledTimes(10);expect(o.wait).toHaveBeenCalledTimes(9);
});
it('prioritizes concurrent 429 over 403 without retrying',async()=>{
  const o=options();
  await expect(collectSeatObservation([1,2],async id=>{throw id===1?blocked():new CgvHttpError(429,'1800','limited');},o)).rejects.toThrow('429');
  expect(o.wait).not.toHaveBeenCalled();
});
it('does not retry a malformed response or pass the deadline',async()=>{
  const o=options();
  await expect(collectSeatObservation([1],async()=>{throw Error('Malformed');},o)).rejects.toThrow('Malformed');
  await expect(collectSeatObservation([1],async()=>{throw blocked();},{...o,deadline:4000})).rejects.toThrow('403');
  expect(o.wait).not.toHaveBeenCalled();
});
