import { expect, it } from 'vitest';
import { parseApiSchedule } from '../src/collectors/cgv-api';
import { makeScheduleTransfer, validateScheduleTransfer } from '../src/core/schedule-transfer';
const now = new Date('2026-09-27T00:00:00Z');
function schedule() {
  const row = { coCd: 'A420', siteNo: '0013', scnYmd: '20260928', scnsNo: '018', scnSseq: '4',
    scnsNm: 'IMAX관', expoScnsNm: 'IMAX관', movNm: '영화', movNo: '12345', movkndDsplEnm: 'IMAX', scnsrtTm: '1800', cntlYn: 'N', frSeatCnt: '2' };
  return { dates: ['2026-09-28'], ...parseApiSchedule([row], '2026-09-28', now) };
}
it('preserves screening codes for the production time links and stable hashes', () => {
  const s = schedule(); const p = makeScheduleTransfer(s, now);
  expect(p.sessions[0].seatQuery?.scnSseq).toBe('4');
  expect(validateScheduleTransfer(p, now)).toEqual(p);
  expect(makeScheduleTransfer(s, new Date(+now + 1000)).hash).toBe(p.hash);
  expect(makeScheduleTransfer({...s, seatCandidates: s.seatCandidates.map(c => ({...c, seatQuery:{...c.seatQuery,scnSseq:'5'}}))},now).hash).not.toBe(p.hash);
});
it('rejects partial, stale, forged, duplicate and malformed payloads', () => {
  const s = schedule(); const p = makeScheduleTransfer(s, now);
  expect(() => makeScheduleTransfer({...s,failedDates:['2026-09-29']}, now)).toThrow();
  expect(() => validateScheduleTransfer(p,new Date(+now + 180001))).toThrow();
  expect(() => validateScheduleTransfer({...p,hash:'bad'}, now)).toThrow();
  expect(() => makeScheduleTransfer({...s, seatCandidates:[]},now)).toThrow();
  expect(() => makeScheduleTransfer({...s, seatCandidates:[...s.seatCandidates,...s.seatCandidates]},now)).toThrow();
  expect(() => makeScheduleTransfer({...s, seatCandidates:s.seatCandidates.map(c=>({...c,seatQuery:{...c.seatQuery,scnsNo:'999'}}))},now)).toThrow();
});
