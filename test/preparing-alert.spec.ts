import { describe, it, expect, vi } from 'vitest';
import { parseApiSchedule } from '../src/collectors/cgv-api';
import { makeScheduleTransfer, validateScheduleTransfer } from '../src/core/schedule-transfer';
import { withinTelegramLimits } from '../src/core/telegram';
const now = new Date('2026-10-06T00:00:00+09:00');
const raw = { coCd:'A420', siteNo:'0013', scnsNo:'018', scnSseq:'3', scnYmd:'20261006',
  scnsNm:'IMAX관', expoScnsNm:'IMAX관', movNm:'오디세이', movNo:'30001323',
  movkndDsplEnm:'IMAX LASER 2D', scnsrtTm:'1430', cntlYn:'Y', frSeatCnt:'0' };
const collect = (change = {}) => parseApiSchedule([{...raw,...change}], '2026-10-06', now);
const session = () => collect().preparingSessions[0];
describe('preparation alerts', () => {
  it('keeps controlled zero-seat sessions separate and preserves real links', () => {
    const p = collect();
    expect(p.sessions).toEqual([]); expect(p.seatCandidates).toEqual([]);
    expect(session().seatQuery?.scnSseq).toBe('3');
    expect(collect({cntlYn:'N',frSeatCnt:'5'}).sessions[0].performanceId).toBe(session().performanceId);
    expect(collect({scnsrtTm:'0000'}).preparingSessions).toHaveLength(0);
  });
  it('omits links when real identifiers are missing', () => {
    const p = collect({scnSseq:undefined});
    expect(p.preparingSessions).toHaveLength(1);
  });
  it('hashes preparation changes and validates backward-compatible transfers', () => {
    const p = collect();
    const data = { dates:['2026-10-06'],...p };
    const transfer = makeScheduleTransfer(data,now);
    expect(validateScheduleTransfer(transfer,now)).toEqual(transfer);
    expect(makeScheduleTransfer({...data,preparingSessions:[]},now).hash).not.toBe(transfer.hash);
    const {preparingSessions,...old}=data;
    expect(validateScheduleTransfer(makeScheduleTransfer(old,now),now).preparingSessions).toBeUndefined();
    expect(()=>makeScheduleTransfer({...data,seatCandidates:[{...session(),seatQuery:session().seatQuery!,isDayBoundary:false}]},now)).toThrow();
  });
});
