import type { CinemaSession, PendingNotification } from "./types";

export interface SessionRepository {
	discardNotification?(notificationId: string, now: string): Promise<void>;
	isInitialized(): Promise<boolean>;
	listKnownPerformanceIds(
		performanceIds: readonly string[],
	): Promise<Set<string>>;
	storeNewSessions(
		sessions: CinemaSession[],
		now: string,
		createNotifications: boolean,
	): Promise<number>;
	markInitialized(now: string): Promise<void>;
	listPending(limit?: number): Promise<PendingNotification[]>;
	markSent(performanceIds: string[], now: string): Promise<void>;
	markFailed(performanceIds: string[], error: string): Promise<void>;
}
