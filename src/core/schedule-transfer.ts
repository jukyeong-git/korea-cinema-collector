import { createHash } from 'node:crypto';
import { makeSchedulePayload, validateSchedulePayload } from './schedule-payload';
import type { PublishedSchedule, SeatCandidate } from './types';

export interface ScheduleTransfer extends PublishedSchedule {
  version: 2; kind: 'schedule'; observedAt: string; hash: string; seatCandidates: SeatCandidate[];
}
function content(schedule: PublishedSchedule, now: Date) {
  if (schedule.failedDates?.length || !Array.isArray(schedule.seatCandidates)) throw Error('Complete schedule required');
  const base = validateSchedulePayload(makeSchedulePayload(schedule, now), now);
  const seats = validateSchedulePayload(makeSchedulePayload({ dates: schedule.dates, sessions: schedule.seatCandidates }, now), now);
  const byId = new Map(schedule.seatCandidates.map(s => [s.performanceId, s]));
  const seatCandidates = seats.sessions.map(s => {
    const raw = byId.get(s.performanceId)!;
    const q = raw.seatQuery;
    if (!q || q.coCd !== 'A420' || q.siteNo !== '0013' || q.scnsNo !== '018'
      || q.scnYmd !== s.displayDate.replaceAll('-', '') || typeof q.scnSseq !== 'string' || !/^\d+$/.test(q.scnSseq)
      || typeof raw.isDayBoundary !== 'boolean') throw Error('Invalid seat query');
    return { ...s, isDayBoundary: raw.isDayBoundary,
      seatQuery: { coCd: q.coCd, siteNo: q.siteNo, scnYmd: q.scnYmd, scnsNo: q.scnsNo, scnSseq: q.scnSseq } };
  });
  const candidates = new Map(seatCandidates.map(c => [c.performanceId, c]));
  const sessions = base.sessions.map(s => {
    const c = candidates.get(s.performanceId);
    if (!c || c.movieNo !== s.movieNo || c.formatCode !== s.formatCode) throw Error('Session missing matching candidate');
    return { ...s, seatQuery: c.seatQuery };
  });
  return { dates: base.dates, sessions, seatCandidates };
}
export function makeScheduleTransfer(schedule: PublishedSchedule, now = new Date()): ScheduleTransfer {
  const canonical = content(schedule, now);
  const hash = createHash('sha256').update(JSON.stringify({ version: 2, kind: 'schedule', ...canonical })).digest('hex');
  return { version: 2, kind: 'schedule', observedAt: now.toISOString(), hash, ...canonical };
}
export function validateScheduleTransfer(value: unknown, now = new Date()): ScheduleTransfer {
  if (!value || typeof value !== 'object') throw Error('Invalid schedule transfer');
  const p = value as ScheduleTransfer;
  const age = now.getTime() - Date.parse(p.observedAt);
  if (p.version !== 2 || p.kind !== 'schedule' || !Number.isFinite(age) || age < -10000 || age > 180000) throw Error('Invalid or stale schedule transfer');
  const clean = makeScheduleTransfer(p, new Date(p.observedAt));
  if (p.hash !== clean.hash) throw Error('Schedule transfer hash mismatch');
  return clean;
}
