import type { PendingNotification } from "./types";

export function displayTimeToMinutes(displayTime: string): number | null {
	const match = /^(\d{2}):(\d{2})$/.exec(displayTime);
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 47 || minute > 59) return null;
	return hour * 60 + minute;
}

export function comparePendingNotifications(
	a: PendingNotification,
	b: PendingNotification,
): number {
	const titleComparison = a.title.localeCompare(b.title);
	if (titleComparison !== 0) return titleComparison;

	const dateComparison = a.displayDate.localeCompare(b.displayDate);
	if (dateComparison !== 0) return dateComparison;

	const venueComparison = a.venue.localeCompare(b.venue);
	if (venueComparison !== 0) return venueComparison;

	const aTime = displayTimeToMinutes(a.displayTime);
	const bTime = displayTimeToMinutes(b.displayTime);
	if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime;
	if (aTime !== null && bTime === null) return -1;
	if (aTime === null && bTime !== null) return 1;

	const timeComparison = a.displayTime.localeCompare(b.displayTime);
	if (timeComparison !== 0) return timeComparison;

	return 0;
}
