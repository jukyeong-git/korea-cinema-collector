import { expect,it,vi } from 'vitest';
import { retryCollection } from '../src/core/retry-collection';
import { annotateError,errorDetails,checkReceiver,StaleScheduleError } from '../src/core/error-details';
import { CgvHttpError } from '../src/collectors/cgv-api';
function options(){let time=0;return {deadline:200000,now:()=>time,wait:vi.fn(async(ms:number)=>{time+=ms;}),phase:()=> 'collection',report:vi.fn()};}
it('logs timeout context and retries after one minute with a fresh observation',async()=>{
 const o=options(),error=annotateError(new Error('page.evaluate: TimeoutError: signal timed out'),{endpoint:'/api/v1/booking/searchMovScnInfo',date:'20260928',durationMs:15000});
 const work=vi.fn().mockRejectedValueOnce(error).mockResolvedValue('fresh');
 expect(await retryCollection(work,o)).toBe('fresh');expect(o.wait).toHaveBeenCalledWith(60000);
 expect(o.report).toHaveBeenCalledWith(expect.objectContaining({category:'timeout',date:'20260928',durationMs:15000,retry:true}));
});
it('never retries 403, 429 or a stale snapshot in the general retry layer',async()=>{
 for(const error of [new CgvHttpError(403,null,'blocked'),new CgvHttpError(429,'1800','limited'),new StaleScheduleError()]){
 const o=options(),work=vi.fn().mockRejectedValue(error);
 await expect(retryCollection(work,o)).rejects.toBe(error);expect(work).toHaveBeenCalledTimes(1);expect(o.wait).not.toHaveBeenCalled();
 }
});
it('bounds repeated other failures by the original deadline',async()=>{
 const o=options(),work=vi.fn().mockRejectedValue(new SyntaxError('bad JSON'));
 await retryCollection(work,o);expect(work).toHaveBeenCalledTimes(4);expect(o.wait).toHaveBeenCalledTimes(3);
});
it('does not expose response messages, account identifiers or credentials',()=>{
 const error=Object.assign(new Error('token=secret-cookie AWS arn:aws:lambda:region:123456789012:function:private secret-table'),{name:'private-function'});
 const output=JSON.stringify(errorDetails(error));
 for(const value of ['secret-cookie','123456789012','private-function','secret-table','arn:aws'])expect(output).not.toContain(value);
});
it('recognizes stale Lambda responses without exposing other receiver error bodies',()=>{
 const payload=(message:string)=>new TextEncoder().encode(JSON.stringify({errorMessage:message}));
 expect(()=>checkReceiver({FunctionError:'Unhandled',Payload:payload('Missing or stale DynamoDB schedule snapshot')})).toThrow(StaleScheduleError);
 expect(()=>checkReceiver({FunctionError:'Unhandled',Payload:payload('secret-account')})).toThrow('Receiver function failed');
 expect(checkReceiver({StatusCode:200,Payload:new TextEncoder().encode('{"accepted":true}')})).toEqual({accepted:true});
});
