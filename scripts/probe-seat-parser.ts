import type { SeatCandidate, SeatSnapshot } from "../src/core/types";
import { CGV_USER_AGENT, CgvHttpError } from "../src/collectors/cgv-api";

export const PREFERRED_ROWS = "FGHIJKL";
export function isPreferredSeat(row: string, number: number): boolean {
  return row.length === 1 && PREFERRED_ROWS.includes(row)
    && number >= 16 && number <= 29;
}
export function seatIdentity(candidate: SeatCandidate): string {
  const q = candidate.seatQuery;
  return [q.coCd, q.siteNo, q.scnYmd, q.scnsNo, q.scnSseq].join("#");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Malformed CGV seat response");
  return value as Record<string, unknown>;
}

// Verified against the anonymous web seat endpoint on 2026-09-10. The row
// label or stkndNm alone cannot establish eligibility (wheelchair seats also
// carry the label 일반석). Require normal sale form AND available status.
export function parseSeatResponse(value: unknown, candidate: SeatCandidate): SeatSnapshot {
  const root = record(value), data = record(root.data);
  if (root.statusCode !== 0 || String(data.resultCode) !== "0") throw Error("CGV seat query failed");
  for (const key of ["coCd", "siteNo", "scnYmd", "scnsNo"] as const) {
    if (data[key] !== candidate.seatQuery[key]) throw Error("CGV seat response identity mismatch");
  }
  if (!Array.isArray(data.items) || !data.items.length) throw Error("Missing CGV seat areas");
  const seen = new Set<string>(), target = new Set<string>(), available: string[] = [];
  for (const area of data.items) {
    const seats = record(area).seats;
    if (!Array.isArray(seats) || !seats.length) throw Error("Missing CGV seats");
    for (const value of seats) {
      const seat = record(value);
      const row = seat.seatRowNm, number = seat.seatNo;
      if (typeof row !== "string" || !/^[A-P]$/.test(row) || typeof number !== "string" || !/^[1-9]\d?$/.test(number)) throw Error("Invalid CGV seat label");
      const label = row + number;
      if (seen.has(label)) throw Error("Duplicate CGV seat label");
      seen.add(label);
      if (!["Y", "N"].includes(String(seat.seatSaleYn)) || !/^\d{2}$/.test(String(seat.seatStusCd)) || !/^\d{2}$/.test(String(seat.seatSalfrmCd))) throw Error("Unknown CGV seat flags");
      if (!isPreferredSeat(row, Number(number))) continue;
      target.add(label);
      if (seat.seatSalfrmCd === "01" && seat.seatSaleYn === "Y" && seat.seatStusCd === "00") available.push(label);
    }
  }
  // Incomplete, blocked and redesigned responses must never erase a baseline.
  if (seen.size !== 624 || target.size !== 98) throw Error(`Unexpected Yongsan seat layout: ${seen.size}/${target.size}`);
  return { identity: seatIdentity(candidate), available: available.sort((a, b) => a.localeCompare(b, "en", { numeric: true })) };
}

export async function fetchPreferredSeats(candidate: SeatCandidate, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<SeatSnapshot> {
  const url = new URL("https://cgv.co.kr/api/v1/booking/searchIfSeatData");
  url.search = new URLSearchParams(candidate.seatQuery).toString();
  const response = await fetcher(url, {
    headers: { "user-agent": CGV_USER_AGENT, accept: "application/json", referer: "https://cgv.co.kr/cnm/movieBook/cinema" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (!response.ok) throw new CgvHttpError(response.status, response.headers.get("retry-after"), body.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]").slice(0, 4096));
  return parseSeatResponse(JSON.parse(body), candidate);
}
