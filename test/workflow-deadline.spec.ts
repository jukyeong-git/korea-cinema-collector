import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
const workflows=['schedule',...Array.from({length:7},(_,i)=>`seats-0${i+1}`)];
function deadline(name:string, time:string, minutes='59.5') {
  const yaml=readFileSync(`.github/workflows/${name}.yml`,'utf8');
  const code=yaml.match(/node -e '(.*)'/)![1];
  let output='';
  runInNewContext(code,{
    Date:{now:()=>Date.parse(time)},
    process:{env:{REQUESTED_MINUTES:minutes,GITHUB_ENV:'env'},exit:()=>{throw Error('invalid budget');}},
    require:()=>({appendFileSync:(_path:string,text:string)=>{output+=text;}}),
  });
  return Number(output.match(/COLLECTOR_END_AT=(\d+)/)![1]);
}
it.each(workflows)('%s limits manual and delayed jobs to the next hour boundary', name=>{
  expect(deadline(name,'2026-09-27T11:27:30Z')).toBe(Date.parse('2026-09-27T11:59:30Z'));
  expect(deadline(name,'2026-09-27T11:00:19Z')).toBe(Date.parse('2026-09-27T11:59:30Z'));
  expect(deadline(name,'2026-09-27T11:27:30Z','5')).toBe(Date.parse('2026-09-27T11:32:30Z'));
  // A start inside the cleanup window gets an expired deadline, never a new hour.
  expect(deadline(name,'2026-09-27T11:59:45Z')).toBeLessThan(Date.parse('2026-09-27T11:59:45Z'));
  expect(()=>deadline(name,'2026-09-27T11:27:30Z','0')).toThrow('invalid budget');
});
