export interface CinemaSession {
	performanceId: string;
	title: string;
	movieNo?: string; // Absent on legacy records and the optional browser collector.
	displayDate: string;
	displayTime: string;
	venue: string;
	formatCode: string;
	subtitleCode: string | null;
	bookingUrl: string;
}

export interface SeatCandidate extends CinemaSession {
  isDayBoundary?: boolean; // First/last IMAX show in the complete returned screening day.
  seatQuery: { coCd: string; siteNo: string; scnYmd: string; scnsNo: string; scnSseq: string };
}

export interface SeatSnapshot {
  available: string[];
  identity: string;
}

export interface PendingNotification extends CinemaSession {
  notificationId?: string;
  releasedSeatLabels?: string[];
	attempts: number;
}

export interface SyncResult {
	baselineCreated: boolean;
	datesChecked: number;
	sessionsFound: number;
	newSessions: number;
	notificationsSent: number;
}

export interface PublishedSchedule {
  failedDates?: string[];
  retryAt?: number;
	dates: string[];
	sessions: CinemaSession[];
  seatCandidates?: SeatCandidate[];
}
