import { readyCandidates } from './monday-seat-payload';
import type { SeatCandidate } from './types';

interface StoredSeatSource {
  readSeatCandidates(): Promise<SeatCandidate[] | undefined>;
  loadSeatContext(ids: string[]): Promise<{ firstSeen: Map<string, string> }>;
}

// Read a complete stored schedule; never fall back to CGV schedule requests.
export async function readStoredSeatPlan(source: StoredSeatSource, weekday: number, now: Date) {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw Error('Invalid weekday');
  const snapshot = await source.readSeatCandidates();
  if (!snapshot) throw Error('Missing stored schedule; seat collection stopped');
  const assigned = snapshot.filter(c => new Date(`${c.displayDate}T00:00:00Z`).getUTCDay() === weekday);
  const context = assigned.length
    ? await source.loadSeatContext(assigned.map(c => c.performanceId))
    : { firstSeen: new Map<string, string>() };
  const candidates = readyCandidates(assigned, context.firstSeen, now, weekday);
  return { candidates, dates: [...new Set(candidates.map(c => c.displayDate))] };
}
