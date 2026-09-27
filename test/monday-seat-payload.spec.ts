import {expect,it} from 'vitest';
import {makePayload,validatePayload,readyCandidates,validateAgainstCandidates} from '../src/core/monday-seat-payload';
import type {SeatCandidate} from '../src/core/types';
const now = new Date('2026-09-27T00:00:00Z');
const c = {performanceId:'monday',displayDate:'2026-09-28',displayTime:'25:00',isDayBoundary:true,seatQuery:{coCd:'A420',siteNo:'0013',scnYmd:'20260928',scnsNo:'018',scnSseq:'6'}} as SeatCandidate;
it('accepts current F-L range, rejects old range and incomplete payloads',()=>{
 const e={performanceId:'monday',identity:'A420#0013#20260928#018#6',available:['F16','L29']};
 expect(validatePayload(makePayload([e],now),now).entries).toHaveLength(1);
 expect(()=>validatePayload(makePayload([{...e,available:['G7']}],now),now)).toThrow();
 expect(()=>validatePayload({...makePayload([e],now),partial:true},now)).toThrow();
 expect(()=>validatePayload(makePayload([e],now),new Date(now.getTime()+180001))).toThrow();
 expect(()=>validateAgainstCandidates(makePayload([],now),[c])).toThrow();
 expect(()=>validateAgainstCandidates(makePayload([e],now),[{...c,seatQuery:{...c.seatQuery,scnSseq:'5'}}])).toThrow();
});
it('keeps boundary shows, Monday extended times, and one-hour eligibility',()=>{
 const seen=new Map([['monday',new Date(now.getTime()-3600000).toISOString()]]);
 expect(readyCandidates([c],seen,now)).toEqual([c]);
 expect(readyCandidates([c],seen,new Date(now.getTime()-1))).toEqual([]);
 expect(readyCandidates([{...c,displayDate:'2026-09-29'}],seen,now)).toEqual([]);
});
