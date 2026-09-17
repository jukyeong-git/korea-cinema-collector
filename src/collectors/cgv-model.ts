import { createHash } from "node:crypto";
import type { CinemaSession } from "../core/types";
import type { ScheduleRow } from "./cgv-dom";

export const THEATER_URL = "https://cgv.co.kr/cnm/bzplcCgv/0013001";

// Observed calendar and schedule requests on the public page, 2026-09-08.
export function isScheduleRequest(url: string, type: string): boolean {
  const parsed = new URL(url);
  return (parsed.hostname === "cgv.co.kr" || parsed.hostname === "api.cgv.co.kr")
    && parsed.pathname.startsWith("/api/v1/booking/")
    && ["fetch", "xhr"].includes(type);
}

export function koreaDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export function dateAtOffset(today: string, offset: number): string {
  const date = new Date(`${today}T12:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + offset);
  return koreaDate(date);
}

export function parseRows(rows: ScheduleRow[], date: string): CinemaSession[] {
  const sessions = new Map<string, CinemaSession>();
  for (const row of rows) {
    if (!/IMAX|아이맥스/i.test(row.screen)) continue;
    if (!row.title || !row.format || !/^(?:[0-3]\d|4[0-7]):[0-5]\d$/.test(row.time) || !row.status) {
      throw new Error("CGV IMAX row is missing required fields; inspect the current DOM.");
    }
    // Do not remember a preparation-only row: it must become new when booking opens.
    if (/준비|마감|종료/.test(row.status)) continue;
    if (row.disabled) continue;
    const key = JSON.stringify(["0013001", date, row.screen, row.title, row.time]);
    const performanceId = createHash("sha256").update(key).digest("hex");
    sessions.set(performanceId, {
      performanceId, title: row.title, displayDate: date, displayTime: row.time,
      venue: `CGV 용산아이파크몰 ${row.screen}`, formatCode: row.format,
      subtitleCode: /자막/.test(row.format) ? "자막" : /더빙/.test(row.format) ? "더빙" : null,
      bookingUrl: THEATER_URL,
    });
  }
  return [...sessions.values()];
}

export function scheduleResponseIsEmpty(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || !("statusCode" in payload)
    || payload.statusCode !== 0 || !("data" in payload) || !Array.isArray(payload.data)) {
    throw new Error("CGV schedule response is unsuccessful or malformed.");
  }
  return payload.data.length === 0;
}

export function scheduleDate(value: string | null): string {
  if (!value || !/^\d{8}$/.test(value)) throw new Error("CGV schedule date is missing or invalid.");
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
  if (dateAtOffset(date, 0) !== date) throw new Error("CGV schedule date is invalid.");
  return date;
}
