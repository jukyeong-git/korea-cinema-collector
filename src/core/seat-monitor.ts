import type { SeatCandidate, SeatSnapshot } from "./types";

export const SEAT_DELAY_MS = 60 * 60_000;
// Preserve existing snapshots: changing the wait time does not change the monitored seat set or availability semantics.
export const SEAT_POLICY = "preferred-G-O-v1-after3h";
export interface SeatObservation extends SeatSnapshot { revision: number; policy: string; observedAt: string }
export interface SeatMonitorRepository {
  loadSeatContext(ids: string[]): Promise<{ firstSeen: Map<string, string>; observations: Map<string, SeatObservation> }>;
  storeSeatObservation(candidate: SeatCandidate, snapshot: SeatSnapshot, previous: SeatObservation | undefined, now: string, released: string[]): Promise<boolean>;
}
export function performanceStart(session: { displayDate: string; displayTime: string }): number {
  const [hour, minute] = session.displayTime.split(":").map(Number);
  return Date.parse(`${session.displayDate}T00:00:00+09:00`) + (hour * 60 + minute) * 60_000;
}

export function isPreferredShowtime(session: { displayDate: string; displayTime: string }, weekdays: readonly number[] = [0, 6]): boolean {
  // Use CGV's screening date, not the next calendar day for extended-hour times.
  const weekday = new Date(`${session.displayDate}T00:00:00Z`).getUTCDay();
  return weekdays.includes(weekday);
}

export async function observePreferredSeats(
  candidates: SeatCandidate[], repository: SeatMonitorRepository,
  fetchSeats: (candidate: SeatCandidate) => Promise<SeatSnapshot>,
  notify: boolean, now = new Date(), weekdays: readonly number[] = [0, 6],
): Promise<{ checked: number; baselines: number; events: number }> {
  const eligible = candidates.filter(candidate => isPreferredShowtime(candidate, weekdays) && candidate.isDayBoundary === false);
  const timestamp = now.toISOString(), context = await repository.loadSeatContext(eligible.map(s => s.performanceId));
  const result = { checked: 0, baselines: 0, events: 0 };
  // Collect everything first: a failed/partial round cannot update snapshots.
  const collected: Array<{ candidate: SeatCandidate; snapshot: SeatSnapshot; previous?: SeatObservation }> = [];
  const ready = eligible.filter(candidate => {
    const firstSeen = Date.parse(context.firstSeen.get(candidate.performanceId) ?? "");
    return Number.isFinite(firstSeen) && now.getTime() >= firstSeen + SEAT_DELAY_MS && performanceStart(candidate) > now.getTime();
  });
  let nextIndex = 0;
  let failed = false;
  async function worker() {
    while (!failed && nextIndex < ready.length) {
      const index = nextIndex++;
      const candidate = ready[index];
      try {
        const snapshot = await fetchSeats(candidate);
        collected[index] = { candidate, snapshot, previous: context.observations.get(candidate.performanceId) };
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  const results = await Promise.allSettled(Array.from({ length: Math.min(5, ready.length) }, worker));
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (errors.length) {
    // Preserve the longest server-requested cooldown across in-flight failures.
    const cooldown = (error: unknown): number => error !== null && typeof error === "object" && "retryAt" in error && typeof error.retryAt === "number" && Number.isFinite(error.retryAt) ? error.retryAt : 0;
    errors.sort((a, b) => cooldown(b.reason) - cooldown(a.reason));
    throw errors[0].reason;
  }
  for (const { candidate, snapshot, previous } of collected) {
    const baseline = !previous || previous.policy !== SEAT_POLICY || previous.identity !== snapshot.identity;
    const released = baseline || !notify ? [] : snapshot.available.filter(label => !previous.available.includes(label));
    const changed = baseline || JSON.stringify(previous.available) !== JSON.stringify(snapshot.available);
    result.checked++;
    if (!changed) continue;
    const stored = await repository.storeSeatObservation(candidate, snapshot, previous, timestamp, released);
    if (stored) {
      if (baseline) result.baselines++;
      if (released.length) result.events++;
    }
  }
  return result;
}
