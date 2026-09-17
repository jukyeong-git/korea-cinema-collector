import { createHash } from "node:crypto";
import { parseRows, scheduleDate, THEATER_URL } from "../collectors/cgv-model";
import { performanceStart } from "./seat-monitor";
import type { CinemaSession, PublishedSchedule } from "./types";

export interface SchedulePayload {
  version: 1;
  kind: "schedule";
  observedAt: string;
  hash: string;
  dates: string[];
  sessions: CinemaSession[];
}
function canonical(schedule: Pick<PublishedSchedule, "dates" | "sessions">) {
  return {
    dates: [...schedule.dates].sort(),
    sessions: schedule.sessions.map(s => ({ performanceId: s.performanceId, title: s.title,
      movieNo: s.movieNo, displayDate: s.displayDate, displayTime: s.displayTime,
      venue: s.venue, formatCode: s.formatCode, subtitleCode: s.subtitleCode, bookingUrl: s.bookingUrl,
    })).sort((a, b) => a.performanceId.localeCompare(b.performanceId, "en")),
  };
}
export function scheduleHash(schedule: Pick<PublishedSchedule, "dates" | "sessions">) {
  return createHash("sha256").update(JSON.stringify({ version: 1, kind: "schedule", ...canonical(schedule) })).digest("hex");
}
export function makeSchedulePayload(schedule: PublishedSchedule, now = new Date()): SchedulePayload {
  return { version: 1, kind: "schedule", observedAt: now.toISOString(), hash: scheduleHash(schedule), ...canonical(schedule) };
}
export function validateSchedulePayload(value: unknown, now = new Date()): SchedulePayload {
  if (!value || typeof value !== "object") throw Error("Invalid schedule payload");
  const p = value as SchedulePayload;
  const age = now.getTime() - Date.parse(p.observedAt);
  if (p.version !== 1 || p.kind !== "schedule" || !Number.isFinite(age) || age < -10000 || age > 180000
    || !Array.isArray(p.dates) || !p.dates.length || p.dates.length > 62
    || !Array.isArray(p.sessions) || p.sessions.length > 500) throw Error("Invalid or stale schedule payload");
  const dates = new Set<string>();
  for (const date of p.dates) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || scheduleDate(date.replaceAll("-", "")) !== date || dates.has(date)) throw Error("Invalid schedule dates");
    dates.add(date);
  }
  const ids = new Set<string>();
  for (const s of p.sessions) {
    if (!s || typeof s !== "object" || !dates.has(s.displayDate) || ids.has(s.performanceId)
      || typeof s.movieNo !== "string" || !/^\d+$/.test(s.movieNo)
      || typeof s.title !== "string" || !s.title.trim() || s.title.length > 500
      || typeof s.venue !== "string" || !s.venue.startsWith("CGV 용산아이파크몰 ")
      || typeof s.formatCode !== "string" || !s.formatCode || s.formatCode.length > 200
      || s.bookingUrl !== THEATER_URL || typeof s.displayTime !== "string"
      || !/^(?:[0-3]\d|4[0-7]):[0-5]\d$/.test(s.displayTime)) throw Error("Invalid schedule session");
    const parsed = parseRows([{ title: s.title, screen: s.venue.slice("CGV 용산아이파크몰 ".length),
      format: s.formatCode, time: s.displayTime, status: "예매 가능", disabled: false }], s.displayDate)[0];
    if (!parsed || parsed.performanceId !== s.performanceId || parsed.subtitleCode !== s.subtitleCode
      || performanceStart(s) <= Date.parse(p.observedAt)) throw Error("Invalid schedule identity or start time");
    ids.add(s.performanceId);
  }
  if (p.hash !== scheduleHash(p)) throw Error("Schedule hash mismatch");
  // Strip untrusted extra properties such as notification status or seat events.
  return { version: 1, kind: "schedule", observedAt: p.observedAt, hash: p.hash, ...canonical(p) };
}
