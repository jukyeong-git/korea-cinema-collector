import { expect, it, vi } from 'vitest';
import { readStoredSeatPlan } from '../src/core/stored-seat-plan';
import type { SeatCandidate } from '../src/core/types';

const now = new Date('2026-10-01T12:00:00Z');
const candidate = (id: string, date = '2026-10-05', time = '14:00') => ({
  performanceId: id, displayDate: date, displayTime: time, isDayBoundary: true,
  seatQuery: { coCd: 'A420', siteNo: '0013', scnYmd: date.replaceAll('-', ''), scnsNo: '018', scnSseq: id },
} as SeatCandidate);

it('reads only Monday context and applies one-hour delay and future-show rules', async () => {
  const monday = candidate('ready');
  const rows = [monday, candidate('young'), candidate('unknown'), candidate('tuesday', '2026-10-06'), candidate('expired', '2026-09-28')];
  const source = {
    readSeatCandidates: vi.fn().mockResolvedValue(rows),
    loadSeatContext: vi.fn().mockResolvedValue({ firstSeen: new Map([
      ['ready', new Date(now.getTime() - 3_600_000).toISOString()],
      ['young', new Date(now.getTime() - 3_599_999).toISOString()],
      ['expired', new Date(now.getTime() - 3_600_000).toISOString()],
    ]) }),
  };
  expect(await readStoredSeatPlan(source, 1, now)).toEqual({ candidates: [monday], dates: ['2026-10-05'] });
  expect(source.loadSeatContext).toHaveBeenCalledWith(['ready', 'young', 'unknown', 'expired']);
});

it('refreshes stored candidates on the next cycle and does not turn a missing snapshot into an empty observation', async () => {
  const source = {
    readSeatCandidates: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(undefined),
    loadSeatContext: vi.fn(),
  };
  expect(await readStoredSeatPlan(source, 1, now)).toEqual({ candidates: [], dates: [] });
  await expect(readStoredSeatPlan(source, 1, now)).rejects.toThrow('Missing stored schedule');
  expect(source.readSeatCandidates).toHaveBeenCalledTimes(2);
  expect(source.loadSeatContext).not.toHaveBeenCalled();
});

it('propagates DB errors instead of querying CGV or delivering an empty observation', async () => {
  const source = { readSeatCandidates: vi.fn().mockRejectedValue(Error('AccessDenied')), loadSeatContext: vi.fn() };
  await expect(readStoredSeatPlan(source, 1, now)).rejects.toThrow('AccessDenied');
});
