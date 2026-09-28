import { setTimeout as sleep } from 'node:timers/promises';
import { CgvHttpError } from '../collectors/cgv-api';
import { errorDetails, StaleScheduleError } from './error-details';
export async function retryCollection<T>(operation:()=>Promise<T>, options:{deadline:number; phase:()=>string; report:(event:object)=>void; now?:()=>number; wait?:(ms:number)=>Promise<unknown>}) {
  const now=options.now ?? Date.now, wait=options.wait ?? sleep;
  let attempt=0;
  while(now()<options.deadline) {
    const started=now();attempt++;
    try {return await operation();}
    catch(error) {
      const excluded=error instanceof StaleScheduleError || (error instanceof CgvHttpError && [403,429].includes(error.status));
      const retry=!excluded && now()+60000<options.deadline;
      options.report({event:'operation_failed',phase:options.phase(),attempt,elapsedMs:now()-started,...errorDetails(error),retry,delayMs:retry?60000:undefined});
      if(excluded)throw error;
      if(!retry) {
        options.report({event:'collection_complete',reason:'insufficient time for retry'});
        return;
      }
      await wait(60000);
    }
  }
}
