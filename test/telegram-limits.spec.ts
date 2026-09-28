import {expect,it,vi} from 'vitest';
import {parseRows} from '../src/collectors/cgv-model';
import {buildTelegramPayload,groupNotifications,withinTelegramLimits,telegramTextLength,sendTelegramGroup} from '../src/core/telegram';
const session=parseRows([{title:'영화 <A> & B',screen:'IMAX관',format:'IMAX 2D',time:'18:00',status:'2/624석',disabled:false}],'2026-09-28')[0];
it('counts full HTML and URLs and enforces both inclusive boundaries',()=>{
 expect(telegramTextLength('<b>&amp;</b>')).toBe(12);
 expect(withinTelegramLimits('x'.repeat(4096))).toBe(true);
 expect(withinTelegramLimits('x'.repeat(4097))).toBe(false);
 expect(withinTelegramLimits('<b>x</b>'.repeat(90))).toBe(true);
 expect(withinTelegramLimits('<b>x</b>'.repeat(91))).toBe(false);
 expect(withinTelegramLimits('<b>x</b><code>18:00</code><a href="url">예매</a>'.repeat(30))).toBe(true);
 expect(withinTelegramLimits('<b>x</b><code>18:00</code><a href="url">예매</a>'.repeat(31))).toBe(false);
});
it.each([false,true])('splits notifications without dropping or cutting any session (seats=%s)',seats=>{
 const ns=Array.from({length:180},(_,i)=>({...session,performanceId:String(i),attempts:0,...(seats?{releasedSeatLabels:['F16','F17']}:{} )}));
 const groups=groupNotifications(ns);expect(groups.length).toBeGreaterThan(1);
 expect(groups.flatMap(g=>g.sessions.map(s=>s.performanceId))).toEqual(ns.map(s=>s.performanceId));
 for(const g of groups){const text=buildTelegramPayload('test',g).text;
  expect(withinTelegramLimits(text)).toBe(true);expect(text.length).toBeLessThanOrEqual(4096);
  expect([...text.matchAll(/<a /g)]).toHaveLength(seats ? g.sessions.length : 1);
  expect([...text.matchAll(/<\/a>/g)]).toHaveLength(seats ? g.sessions.length : 1);
  expect(text).toContain('영화 &lt;A&gt; &amp; B');
 }
});
it('rejects an indivisible oversized notification before sending rather than truncating',async()=>{
 const n={...session,title:'가'.repeat(4096),attempts:0};
 expect(()=>groupNotifications([n])).toThrow('Single notification');
 const fetcher=vi.fn();
 await expect(sendTelegramGroup('token','chat',{title:n.title,sessions:[n]},fetcher)).rejects.toThrow('configured limits');
 expect(fetcher).not.toHaveBeenCalled();
});
