import { createHash } from "node:crypto";
import { isPreferredSeat, seatIdentity } from "../collectors/cgv-seats";
import { performanceStart, SEAT_DELAY_MS, SEAT_POLICY } from "./seat-monitor";
import type { SeatCandidate, SeatSnapshot } from "./types";

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export interface SeatEntry extends SeatSnapshot { performanceId: string }
export interface SeatPayload {
  version: 1;
  policy: string;
  observedAt: string;
  hash: string;
  entries: SeatEntry[];
}
export function readyCandidates(candidates: SeatCandidate[], firstSeen: Map<string, string>, now: Date) {
  return candidates.filter(c => c.isDayBoundary === false
    && Number.isFinite(Date.parse(firstSeen.get(c.performanceId) ?? ""))
    && Date.parse(firstSeen.get(c.performanceId)!) + SEAT_DELAY_MS <= now.getTime()
    && performanceStart(c) > now.getTime());
}
export function canonicalEntries(entries: SeatEntry[]): SeatEntry[] {
  return entries.map(e => ({ performanceId: e.performanceId, identity: e.identity,
    available: [...e.available].sort((a, b) => a.localeCompare(b, "en", { numeric: true })) }))
    .sort((a, b) => a.performanceId.localeCompare(b.performanceId, "en"));
}
export function seatsHash(entries: SeatEntry[]): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, policy: SEAT_POLICY, entries: canonicalEntries(entries) })).digest("hex");
}
export function makePayload(entries: SeatEntry[], now = new Date()): SeatPayload {
  return { version: 1, policy: SEAT_POLICY, observedAt: now.toISOString(), hash: seatsHash(entries), entries: canonicalEntries(entries) };
}
export function validatePayload(value: unknown, now = new Date()): SeatPayload {
  if (!value || typeof value !== "object") throw Error("Invalid seat payload");
  const p = value as SeatPayload;
  const age = now.getTime() - Date.parse(p.observedAt);
  if (p.version !== 1 || p.policy !== SEAT_POLICY || !Number.isFinite(age) || age < -10_000 || age > 180_000
    || !Array.isArray(p.entries) || p.entries.length > 500) throw Error("Invalid or stale seat payload");
  const ids = new Set<string>();
  for (const e of p.entries) {
    if (!e || typeof e.performanceId !== "string" || !e.performanceId || ids.has(e.performanceId)
      || typeof e.identity !== "string" || !Array.isArray(e.available) || e.available.length > 270) throw Error("Invalid seat entry");
    ids.add(e.performanceId);
    const labels = new Set<string>();
    for (const label of e.available) {
      const m = typeof label === "string" && /^([G-O])([1-9]\d?)$/.exec(label);
      if (!m || !isPreferredSeat(m[1], Number(m[2])) || labels.has(label)) throw Error("Invalid preferred seat");
      labels.add(label);
    }
  }
  if (p.hash !== seatsHash(p.entries)) throw Error("Seat hash mismatch");
  return { ...p, entries: canonicalEntries(p.entries) };
}
export function validateAgainstCandidates(payload: SeatPayload, ready: SeatCandidate[]) {
  const expected = new Map(ready.map(c => [c.performanceId, c]));
  if (payload.entries.length !== expected.size) throw Error("Incomplete or changed candidate set");
  for (const e of payload.entries) {
    const c = expected.get(e.performanceId);
    if (!c || e.identity !== seatIdentity(c)) throw Error("Payload does not match current DynamoDB candidates");
  }
}
