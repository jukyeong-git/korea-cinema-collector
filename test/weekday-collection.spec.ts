import {expect,it,vi} from 'vitest';
import {fetchApiImaxSessions} from '../src/collectors/cgv-api';
const now=()=>new Date('2026-09-27T00:00:00Z');
it.each([0,1,2,3,4,5,6])('only requests dates belonging to weekday %i',async weekday=>{
 const dates=['20260927','20260928','20260929','20260930','20261001','20261002','20261003'];
 const requested:string[]=[];
 const fetcher=vi.fn(async(input: string | URL | Request)=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith('searchSiteScnscYmdListBySite'))return Response.json({statusCode:0,data:dates.map(scnYmd=>({scnYmd}))});
  requested.push(url.searchParams.get('scnYmd')!);return Response.json({statusCode:0,data:[]});
 });
 const result=await fetchApiImaxSessions({fetch:fetcher,now,weekday});
 expect(requested).toEqual([dates[weekday]]);expect(result.seatCandidates).toEqual([]);
});
it('allows no matching dates but never treats a failed calendar as empty',async()=>{
 const fetcher=vi.fn(async()=>Response.json({statusCode:0,data:[{scnYmd:'20260928'}]}));
 expect(await fetchApiImaxSessions({fetch:fetcher,now,weekday:2})).toEqual({dates:[],sessions:[],seatCandidates:[]});
 expect(fetcher).toHaveBeenCalledOnce();
 await expect(fetchApiImaxSessions({fetch:async()=>new Response('denied',{status:403}),now,weekday:2})).rejects.toMatchObject({status:403});
});
