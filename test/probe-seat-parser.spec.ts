import { readFileSync } from 'node:fs';
import { it, expect, vi } from 'vitest';
import { parseSeatResponse, fetchPreferredSeats } from '../scripts/probe-seat-parser';
import { parseApiSchedule } from '../src/collectors/cgv-api';
import type { SeatCandidate } from '../src/core/types';
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/cgv-seat-layout.json", import.meta.url), "utf8"));
const candidate: SeatCandidate = { performanceId: "test", isDayBoundary: false, title: "오디세이", movieNo: "30001323", displayDate: "2026-09-12", displayTime: "18:00", venue: "CGV 용산아이파크몰 IMAX관", formatCode: "IMAX", subtitleCode: null, bookingUrl: "https://cgv.co.kr", seatQuery: { coCd: "A420", siteNo: "0013", scnYmd: "20260912", scnsNo: "018", scnSseq: "4" } };
const now = new Date("2026-09-10T12:00:00+09:00");

it("monitors only F–L 16–29, excluding wheelchair and outside seats", () => {
  const b = fixture();
  expect(parseSeatResponse(b, candidate).available).toEqual([]);
  for (const s of b.data.items[0].seats) {
    if (["F16", "F29", "K16", "K17", "K18", "K19", "L29", "H10", "M22", "F15", "L30"].includes(s.seatRowNm + s.seatNo)) Object.assign(s, { seatSaleYn: "Y", seatStusCd: "00", seatSalfrmCd: "01" });
  }
  expect(parseSeatResponse(b, candidate).available).toEqual(["F16", "F29", "K16", "K17", "K18", "K19", "L29"]);
  const k16 = b.data.items[0].seats.find((s: any) => s.seatRowNm === "K" && s.seatNo === "16");
  k16.seatSalfrmCd = "04";
  expect(parseSeatResponse(b, candidate).available).not.toContain("K16");
});
it("rejects incomplete, duplicate, wrong-show and failed seat responses instead of treating them as zero", () => {
  for (const mutate of [
    (b: any) => b.data.items[0].seats.pop(),
    (b: any) => b.data.items[0].seats.push(b.data.items[0].seats[0]),
    (b: any) => b.data.scnYmd = "20260913",
    (b: any) => b.data.resultCode = "1",
    (b: any) => b.data.items = [],
    (b: any) => b.data.items[0].seats[0].seatSaleYn = "?",
  ]) { const b = fixture(); mutate(b); expect(() => parseSeatResponse(b, candidate)).toThrow(); }
});
it("keeps sold-out candidate identifiers without turning it into a new bookable session", () => {
  const row = { ...candidate.seatQuery, scnsNm: "IMAX관", expoScnsNm: "IMAX관", movNm: "오디세이", movNo: "30001323", movkndDsplEnm: "IMAX", scnsrtTm: "1800", cntlYn: "N", frSeatCnt: "0" };
  const p = parseApiSchedule([row], "2026-09-12", now);
  expect(p.sessions).toEqual([]); expect(p.seatCandidates).toHaveLength(1);
  expect(p.seatCandidates[0].seatQuery).toEqual(candidate.seatQuery);
  expect(parseApiSchedule([{ ...row, cntlYn: "Y" }], "2026-09-12", now).seatCandidates).toEqual([]);
});
it("propagates seat rate limits with cooldown metadata, without retrying", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("limited", { status: 429, headers: { "retry-after": "120" } }));
  await expect(fetchPreferredSeats(candidate, undefined, fetcher)).rejects.toMatchObject({ status: 429, retryAfter: "120" });
  expect(fetcher).toHaveBeenCalledOnce();
});
