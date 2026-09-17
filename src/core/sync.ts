import { performanceStart } from "./seat-monitor";
import type { SessionRepository } from "./session-repository";
import { groupNotifications } from "./telegram";
import type { NotificationGroup } from "./telegram";
import type {
	CinemaSession,
	PublishedSchedule,
  SeatCandidate,
  PendingNotification,
	SyncResult,
} from "./types";

export interface SyncDependencies {
	repository: SessionRepository;
	fetchSessions: () => Promise<PublishedSchedule>;
	sendNotification: (group: NotificationGroup) => Promise<void>;
	notificationsEnabled?: boolean;
  observeSeats?: (candidates: SeatCandidate[], notify: boolean) => Promise<void>;
  currentAvailableSeats?: Map<string, string[]>;
}

export function findNewSessions(
	sessions: CinemaSession[],
	knownPerformanceIds: ReadonlySet<string>,
): CinemaSession[] {
	return sessions.filter(
		(session) => !knownPerformanceIds.has(session.performanceId),
	);
}

export async function runSync(
	dependencies: SyncDependencies,
	now = new Date(),
): Promise<SyncResult> {
	const timestamp = now.toISOString();
	const { repository } = dependencies;
	const notificationsEnabled = dependencies.notificationsEnabled ?? true;
	const initialized = await repository.isInitialized();
	const { dates, sessions, seatCandidates } = await dependencies.fetchSessions();
	const knownPerformanceIds = await repository.listKnownPerformanceIds(
		sessions.map((session) => session.performanceId),
	);
	const newSessions = findNewSessions(sessions, knownPerformanceIds);
	const newSessionCount = await repository.storeNewSessions(
		newSessions,
		timestamp,
		initialized && notificationsEnabled,
	);


	if (!initialized) {
		await repository.markInitialized(timestamp);
		return {
			baselineCreated: true,
			datesChecked: dates.length,
			sessionsFound: sessions.length,
			newSessions: newSessionCount,
			notificationsSent: 0,
		};
	}

	if (!notificationsEnabled) {
    if (dependencies.observeSeats && seatCandidates) await dependencies.observeSeats(seatCandidates, false);
		return {
			baselineCreated: false,
			datesChecked: dates.length,
			sessionsFound: sessions.length,
			newSessions: newSessionCount,
			notificationsSent: 0,
		};
	}

  // Enrich pre-migration pending records from the same performance, never by title.
  const currentMovies = new Map([...sessions, ...(seatCandidates ?? [])].map(s => [s.performanceId, s.movieNo]));
  let notificationsSent = 0;
  async function deliver(pending: PendingNotification[]) {
    for (const group of groupNotifications(pending.map(item => {
      const movieNo = item.movieNo ?? currentMovies.get(item.performanceId);
      return movieNo ? { ...item, movieNo } : item;
    }))) {
      const ids = group.sessions.map(s => s.notificationId ?? s.performanceId);
      try {
        await dependencies.sendNotification(group);
        await repository.markSent(ids, timestamp);
        notificationsSent += group.sessions.length;
      } catch (error) {
        await repository.markFailed(ids, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
  }
  // New openings must not be held hostage by a seat endpoint failure.
  await deliver((await repository.listPending()).filter(s => s.releasedSeatLabels === undefined));
  if (dependencies.observeSeats && seatCandidates) {
    await dependencies.observeSeats(seatCandidates, true);
    const pending = (await repository.listPending()).filter(s => s.releasedSeatLabels !== undefined);
    const deliverable: PendingNotification[] = [];
    for (const item of pending) {
      if (performanceStart(item) <= Date.now()) {
        if (repository.discardNotification) await repository.discardNotification(item.notificationId!, timestamp);
        continue;
      }
      const available = dependencies.currentAvailableSeats?.get(item.performanceId);
      // No fresh successful observation (removed/controlled/started show): don't
      // claim its old seats are currently open. Expired events are removed by TTL.
      if (!available) continue;
      const labels = item.releasedSeatLabels!.filter(label => available.includes(label));
      if (labels.length) deliverable.push({ ...item, releasedSeatLabels: labels });
      else if (repository.discardNotification) await repository.discardNotification(item.notificationId!, timestamp);
    }
    await deliver(deliverable);
  }

	return {
		baselineCreated: false,
		datesChecked: dates.length,
		sessionsFound: sessions.length,
		newSessions: newSessionCount,
		notificationsSent,
	};
}
