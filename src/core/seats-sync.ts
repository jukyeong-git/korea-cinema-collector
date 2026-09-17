import type { SeatCandidate } from "./types";
import type { SyncDependencies } from "./sync";
import { performanceStart, isPreferredShowtime } from "./seat-monitor";
import { groupNotifications } from "./telegram";

// This worker never reads the schedule API or delivers new-opening events.
export async function runSeatsSync(deps: Omit<SyncDependencies, "fetchSessions">, candidates: SeatCandidate[], now = new Date(), weekdays: readonly number[] = [0, 6]) {
  const notify = deps.notificationsEnabled ?? true;
  if (!deps.observeSeats) throw Error("Seat observer is required");
  candidates = candidates.filter(candidate => isPreferredShowtime(candidate, weekdays));
  await deps.observeSeats(candidates, notify);
  if (!notify) {
    for (const item of await deps.repository.listPending()) {
      if (item.releasedSeatLabels !== undefined && isPreferredShowtime(item, weekdays)) {
        await deps.repository.discardNotification?.(item.notificationId!, now.toISOString());
      }
    }
    return { notificationsSent: 0 };
  }
  const current = new Map(candidates.map(c => [c.performanceId, c]));
  const deliverable = [];
  for (const item of await deps.repository.listPending()) {
    if (item.releasedSeatLabels === undefined) continue;
    // Other shards own their pending events; never discard them.
    if (!isPreferredShowtime(item, weekdays)) continue;
    if (performanceStart(item) <= now.getTime()) {
      await deps.repository.discardNotification?.(item.notificationId!, now.toISOString());
      continue;
    }
    const available = deps.currentAvailableSeats?.get(item.performanceId);
    if (!available) continue;
    const labels = item.releasedSeatLabels.filter(label => available.includes(label));
    if (!labels.length) {
      await deps.repository.discardNotification?.(item.notificationId!, now.toISOString());
      continue;
    }
    const movieNo = item.movieNo ?? current.get(item.performanceId)?.movieNo;
    deliverable.push({ ...item, ...(movieNo ? { movieNo } : {}), releasedSeatLabels: labels });
  }
  let notificationsSent = 0;
  for (const group of groupNotifications(deliverable)) {
    const ids = group.sessions.map(s => s.notificationId!);
    try {
      await deps.sendNotification(group);
      await deps.repository.markSent(ids, now.toISOString());
      notificationsSent += ids.length;
    } catch (error) {
      await deps.repository.markFailed(ids, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  return { notificationsSent };
}
