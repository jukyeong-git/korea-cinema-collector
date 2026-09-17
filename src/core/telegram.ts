import { formatReleasedSeats } from "./seat-labels";
import type { PendingNotification } from "./types";
import { comparePendingNotifications } from "./order";

export interface NotificationGroup {
	title: string;
	sessions: PendingNotification[];
	subtitleText?: string;
}

const MAX_TELEGRAM_TEXT_LENGTH = 4096;

export function groupNotifications(
	notifications: PendingNotification[],
): NotificationGroup[] {
	const groups = new Map<string, NotificationGroup>();
	for (const notification of [...notifications].sort(comparePendingNotifications)) {
		const key = JSON.stringify([notification.title, notification.movieNo ?? "", notification.releasedSeatLabels !== undefined]);
		const group = groups.get(key) ?? {
			title: notification.title,
			sessions: [],
		};
		group.sessions.push(notification);
		groups.set(key, group);
	}

	return [...groups.values()].flatMap((group) =>
		splitNotificationGroup({
			...group,
			subtitleText: formatSubtitleCodes(group.sessions),
		}),
	);
}

function groupSessionsByDate(
	sessions: PendingNotification[],
): Array<{ displayDate: string; sessions: PendingNotification[] }> {
	const dates = new Map<string, PendingNotification[]>();
	for (const session of [...sessions].sort(comparePendingNotifications)) {
		const dateSessions = dates.get(session.displayDate) ?? [];
		dateSessions.push(session);
		dates.set(session.displayDate, dateSessions);
	}

	return [...dates].map(([displayDate, dateSessions]) => ({
		displayDate,
		sessions: dateSessions,
	}));
}

function displayVenue(venue: string): string {
	return venue;
}

function escapeTelegramHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function escapeTelegramHtmlAttribute(value: string): string {
	return escapeTelegramHtml(value).replaceAll('"', "&quot;");
}

const SUBTITLE_LABELS: Record<string, string> = {
	ECSB: "영어·중국어 자막",
	ENSB: "영어 자막",
	CNSB: "중국어 자막",
	NOSB: "자막 없음",
};
const TIME_COLUMN_GAP = "\u2007\u2007";

export function formatSubtitleCodes(sessions: PendingNotification[]): string {
	const codes = new Set(
		sessions.map((session) => session.subtitleCode?.trim() || null),
	);
	if (codes.size > 1) return "회차별 자막 상이";

	const code = [...codes][0];
	if (!code) return "자막 정보 미제공";
	return SUBTITLE_LABELS[code] ?? code;
}

function formatVenueShowtimes(
	sessions: PendingNotification[],
	timeColumnWidth: number,
): string[] {
	const venues = new Map<string, PendingNotification[]>();
	for (const session of sessions) {
		const venue = displayVenue(session.venue);
		const venueSessions = venues.get(venue) ?? [];
		venueSessions.push(session);
		venues.set(venue, venueSessions);
	}

	return [...venues].flatMap(([, venueSessions], index) => {
		const timeRows: string[] = [];
		for (let sessionIndex = 0; sessionIndex < venueSessions.length; sessionIndex += 2) {
			const first = venueSessions[sessionIndex];
			const second = venueSessions[sessionIndex + 1];
			const firstTime = formatShowtime(first, timeColumnWidth);
			if (!second) {
				timeRows.push(firstTime);
				continue;
			}

			const secondTime = formatShowtime(second, timeColumnWidth);
			timeRows.push(`${firstTime}${TIME_COLUMN_GAP}${secondTime}`);
		}

		return [
			...(index === 0 ? [] : [""]),
			...timeRows,
		];
	});
}

function formatShowtime(session: PendingNotification, timeColumnWidth: number): string {
	const time = escapeTelegramHtml(session.displayTime.padStart(timeColumnWidth, " "));
	return `<code>${time}</code>`;
}

export function formatDisplayDate(displayDate: string): string {
	const timestamp = Date.parse(`${displayDate}T12:00:00+09:00`);
	if (Number.isNaN(timestamp)) return displayDate;

	return new Intl.DateTimeFormat("ko-KR", {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		timeZone: "Asia/Seoul",
	}).format(new Date(timestamp));
}

export function dateBookingUrl(displayDate: string, movieNo?: string): string {
	const url = new URL(`https://cgv.co.kr/cnm/movieBook/${movieNo && /^\d+$/.test(movieNo) ? "movie" : "cinema"}`);
	url.search = new URLSearchParams({
		...(movieNo && /^\d+$/.test(movieNo) ? { movNo: movieNo } : {}),
		siteNo: "0013", siteNm: "용산아이파크몰", scnYmd: displayDate.replaceAll("-", ""),
	}).toString();
	return url.toString();
}

export function buildTelegramPayload(chatId: string, group: NotificationGroup) {
  const seatAlert = group.sessions[0]?.releasedSeatLabels !== undefined;
	const timeColumnWidth = Math.max(
		...group.sessions.map((session) => session.displayTime.length),
	);
	const dateSections = groupSessionsByDate(group.sessions).flatMap(
		({ displayDate, sessions }, index) => [
			...(index === 0 ? [] : [""]),
			`<b>🗓️ ${escapeTelegramHtml(formatDisplayDate(displayDate))}</b>`,
			...(seatAlert ? sessions.flatMap((session, sessionIndex) => [
        ...(sessionIndex ? [""] : []),
        escapeTelegramHtml(formatReleasedSeats(session.releasedSeatLabels ?? [])),
        `🕒 ${formatShowtime(session, timeColumnWidth)}`,
        `🎫 <a href="${escapeTelegramHtmlAttribute(dateBookingUrl(displayDate, session.movieNo))}">예매</a>`,
      ]) : [...formatVenueShowtimes(sessions, timeColumnWidth),
        `🎫 <a href="${escapeTelegramHtmlAttribute(dateBookingUrl(displayDate, sessions[0].movieNo))}">예매</a>`]),
		],
	);

	return {
		chat_id: chatId,
		text: [
      seatAlert ? "<b>🔔 선호 좌석 오픈</b>" : "<b>⭐ 신규 일정 오픈</b>",
      "",
			`<b>🎬 ${escapeTelegramHtml(group.title)}</b>`,
			`📍 ${[...new Set(group.sessions.map(session => displayVenue(session.venue)))].map(escapeTelegramHtml).join(" · ")}`,
			"",
			...dateSections,
		].join("\n"),
		parse_mode: "HTML",
		disable_web_page_preview: true,
	};
}

export function telegramTextLength(text: string): number {
	return text
		.replace(/<[^>]*>/g, "")
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.length;
}

function splitNotificationGroup(group: NotificationGroup): NotificationGroup[] {
  const result: NotificationGroup[] = [];
  let current: PendingNotification[] = [];
  for (const session of group.sessions) {
    const candidate = { ...group, sessions: [...current, session] };
    const text = buildTelegramPayload("", candidate).text;
    const tooLarge = telegramTextLength(text) > MAX_TELEGRAM_TEXT_LENGTH || (text.match(/<(?:b|code|a)(?:>| )/g)?.length ?? 0) > 90;
    if (tooLarge && current.length) {
      result.push({ ...group, sessions: current });
      current = [session];
    } else current = candidate.sessions;
    const single = buildTelegramPayload("", { ...group, sessions: current }).text;
    if (telegramTextLength(single) > MAX_TELEGRAM_TEXT_LENGTH) throw Error("Single notification exceeds Telegram length");
  }
  if (current.length) result.push({ ...group, sessions: current });
  return result;
}

export async function sendTelegramGroup(
	botToken: string,
	chatId: string,
	group: NotificationGroup,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const response = await fetcher(
		`https://api.telegram.org/bot${botToken}/sendMessage`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(buildTelegramPayload(chatId, group)),
			signal: AbortSignal.timeout(15_000),
		},
	);

	if (!response.ok) {
		throw new Error(
			`Telegram API failed with HTTP ${response.status}`,
		);
	}
	const result = await response.json() as { ok?: boolean };
	if (result.ok !== true) throw new Error("Telegram API did not confirm delivery.");
}
