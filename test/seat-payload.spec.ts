import { expect, it } from "vitest";
import { ALL_DAYS, makePayload, readyCandidates, validateAgainstCandidates, validatePayload } from "../src/core/seat-payload";
import { seatIdentity } from "../src/collectors/cgv-seats";
import type { SeatCandidate } from "../src/core/types";
const now = new Date("2026-09-17T06:00:00Z");
const c: SeatCandidate = { performanceId: "show", title: "영화", displayDate: "2026-09-18", displayTime: "18:00", isDayBoundary: false,
  venue: "IMAX", formatCode: "IMAX", subtitleCode: null, bookingUrl: "", seatQuery: { coCd: "A420", siteNo: "0013", scnYmd: "20260918", scnsNo: "018", scnSseq: "3" } };
const entry = { performanceId: c.performanceId, identity: seatIdentity(c), available: ["H10", "K16"] };
it("hash ignores observation time and ordering, but changes when seats close or open", () => {
  const p = makePayload([entry], now);
  expect(makePayload([{ ...entry, available: [...entry.available].reverse() }], new Date()).hash).toBe(p.hash);
  expect(makePayload([{ ...entry, available: [] }], now).hash).not.toBe(p.hash);
  expect(makePayload([{ ...entry, available: [...entry.available, "K17"] }], now).hash).not.toBe(p.hash);
});
it("combines every weekday while preserving 1h, boundary, unknown and started exclusions", () => {
  expect(ALL_DAYS).toEqual([0, 1, 2, 3, 4, 5, 6]);
  const first = new Map([["show", new Date(now.getTime() - 3600000).toISOString()]]);
  expect(readyCandidates([c], first, now)).toEqual([c]);
  expect(readyCandidates([c], first, new Date(now.getTime() - 1))).toEqual([]);
  expect(readyCandidates([{ ...c, isDayBoundary: true }, { ...c, isDayBoundary: undefined }], first, now)).toEqual([]);
  expect(readyCandidates([c], new Map(), now)).toEqual([]);
  expect(readyCandidates([{ ...c, displayDate: "2026-09-16" }], first, now)).toEqual([]);
});
it("rejects corrupt, stale, duplicate, outside-range and partial payloads before processing", () => {
  const p = makePayload([entry], now);
  expect(validatePayload(p, now)).toEqual(p);
  expect(() => validatePayload({ ...p, hash: "bad" }, now)).toThrow("hash");
  expect(() => validatePayload(p, new Date(now.getTime() + 180001))).toThrow("stale");
  for (const labels of [["F10"], ["G15"], ["K30"], ["O39"], ["H10", "H10"]]) {
    expect(() => validatePayload(makePayload([{ ...entry, available: labels }], now), now)).toThrow("seat");
  }
  expect(() => validatePayload(makePayload([entry, entry], now), now)).toThrow("entry");
  expect(() => validateAgainstCandidates(makePayload([], now), [c])).toThrow("Incomplete");
  expect(() => validateAgainstCandidates(makePayload([{ ...entry, identity: "wrong" }], now), [c])).toThrow("DynamoDB");
});
it("allows explicit nonempty partial observations but still rejects unknown shows and wrong identities", () => {
  const p = { ...makePayload([entry], now), partial: true };
  expect(validatePayload(p, now)).toEqual(p);
  expect(() => validateAgainstCandidates(p, [c, { ...c, performanceId: "other" }])).not.toThrow();
  expect(() => validateAgainstCandidates(p, [])).toThrow("DynamoDB");
  expect(() => validateAgainstCandidates({ ...p, entries: [{ ...entry, identity: "wrong" }] }, [c])).toThrow("DynamoDB");
  expect(() => validatePayload({ ...makePayload([], now), partial: true }, now)).toThrow("Empty partial");
  expect(() => validatePayload({ ...p, partial: "true" }, now)).toThrow("flag");
});
