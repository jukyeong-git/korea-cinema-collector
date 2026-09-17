import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { parseSeatResponse, fetchPreferredSeats } from "../src/collectors/cgv-seats";
import { parseApiSchedule } from "../src/collectors/cgv-api";
import { observePreferredSeats, SEAT_POLICY, type SeatObservation, type SeatMonitorRepository } from "../src/core/seat-monitor";
import type { SeatCandidate } from "../src/core/types";
import { formatReleasedSeats } from "../src/core/seat-labels";
import { buildTelegramPayload, groupNotifications } from "../src/core/telegram";

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/cgv-seat-layout.json", import.meta.url), "utf8"));
const candidate: SeatCandidate = { performanceId: "test", isDayBoundary: false, title: "오디세이", movieNo: "30001323", displayDate: "2026-09-12", displayTime: "18:00", venue: "CGV 용산아이파크몰 IMAX관", formatCode: "IMAX", subtitleCode: null, bookingUrl: "https://cgv.co.kr", seatQuery: { coCd: "A420", siteNo: "0013", scnYmd: "20260912", scnsNo: "018", scnSseq: "4" } };
const now = new Date("2026-09-10T12:00:00+09:00");

it("retains K16–K19 in the range and detects them when sale reopens, excluding wheelchair/outside seats", () => {
  const b = fixture();
  expect(parseSeatResponse(b, candidate).available).toEqual([]);
  for (const s of b.data.items[0].seats) {
    if (["K16", "K17", "K18", "K19", "H10", "F10"].includes(s.seatRowNm + s.seatNo)) Object.assign(s, { seatSaleYn: "Y", seatStusCd: "00", seatSalfrmCd: "01" });
  }
  expect(parseSeatResponse(b, candidate).available).toEqual(["H10", "K16", "K17", "K18", "K19"]);
  const h10 = b.data.items[0].seats.find((s: any) => s.seatRowNm === "H" && s.seatNo === "10");
  h10.seatSalfrmCd = "04";
  expect(parseSeatResponse(b, candidate).available).not.toContain("H10");
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

function memoryMonitor() {
  const firstSeen = new Map([[candidate.performanceId, new Date(now.getTime() - 3600000).toISOString()]]);
  const observations = new Map<string, SeatObservation>();
  const events: string[][] = [];
  const repo: SeatMonitorRepository = {
    loadSeatContext: async () => ({ firstSeen, observations }),
    storeSeatObservation: vi.fn(async (s, snapshot, prev, stamp, released) => {
      observations.set(s.performanceId, { ...snapshot, revision: (prev?.revision ?? 0) + 1, policy: SEAT_POLICY, observedAt: stamp });
      if (released.length) events.push(released); return true;
    }),
  };
  return { repo, firstSeen, observations, events };
}
it("refills five parallel seat slots and persists only after every response succeeds", async () => {
  const m = memoryMonitor();
  const items = Array.from({length:7}, (_,i) => ({...candidate, performanceId:String(i)}));
  items.forEach(item => m.firstSeen.set(item.performanceId, new Date(now.getTime()-3600000).toISOString()));
  const pending: Array<() => void> = [];
  let active=0, peak=0;
  const promise = observePreferredSeats(items,m.repo,async () => {
    active++; peak=Math.max(peak,active);
    await new Promise<void>(resolve => pending.push(() => {active--; resolve();}));
    return {available:[],identity:"show"};
  },true,now);
  await vi.waitFor(()=>expect(pending).toHaveLength(5));
  pending[2]();
  await vi.waitFor(()=>expect(pending).toHaveLength(6));
  pending[5]();
  await vi.waitFor(()=>expect(pending).toHaveLength(7));
  expect(m.repo.storeSeatObservation).not.toHaveBeenCalled();
  for (const i of [0,1,3,4,6]) pending[i]();
  expect(await promise).toMatchObject({checked:7,baselines:7});
  expect(peak).toBe(5);
});
it("stops queued seats on failure, drains in-flight requests and preserves the longest cooldown", async () => {
  const m=memoryMonitor();
  const items=Array.from({length:8},(_,i)=>({...candidate,performanceId:String(i)}));
  items.forEach(item=>m.firstSeen.set(item.performanceId,new Date(now.getTime()-3600000).toISOString()));
  const pending: Array<(error?: Error) => void>=[];
  const get=vi.fn(async()=> {
    await new Promise<void>((resolve,reject)=>pending.push(error=>error ? reject(error) : resolve()));
    return {available:[],identity:"show"};
  });
  const promise=observePreferredSeats(items,m.repo,get,true,now);
  const later=Object.assign(new Error("limited"),{retryAt:now.getTime()+1800000});
  const assertion=expect(promise).rejects.toBe(later);
  await vi.waitFor(()=>expect(pending).toHaveLength(5));
  pending[0](new Error("failed"));
  pending[1](later);
  await new Promise(resolve=>setTimeout(resolve,0));
  pending.slice(2).forEach(resolve=>resolve());
  await assertion;
  expect(get).toHaveBeenCalledTimes(5);
  expect(m.repo.storeSeatObservation).not.toHaveBeenCalled();
});
it("waits 1 hour, creates a silent baseline, then detects individual releases even with no net count increase", async () => {
  const m = memoryMonitor(); let available = ["H10"];
  const get = vi.fn(async () => ({ available, identity: "show" }));
  await observePreferredSeats([candidate], m.repo, get, true, new Date(now.getTime() - 1)); expect(get).not.toHaveBeenCalled();
  expect(await observePreferredSeats([candidate], m.repo, get, true, now)).toMatchObject({ baselines: 1, events: 0 });
  available = ["H11"];
  expect(await observePreferredSeats([candidate], m.repo, get, true, now)).toMatchObject({ events: 1 });
  await observePreferredSeats([candidate], m.repo, get, true, now); expect(m.events).toEqual([["H11"]]);
  available = []; await observePreferredSeats([candidate], m.repo, get, true, now);
  available = ["H11"]; await observePreferredSeats([candidate], m.repo, get, true, now);
  expect(m.events).toEqual([["H11"], ["H11"]]);
});
it("does not persist a partial seat round, and resets baseline when the show mapping changes", async () => {
  const m = memoryMonitor(); m.firstSeen.set("other", m.firstSeen.get("test")!);
  const get = vi.fn().mockResolvedValueOnce({ available: ["H10"], identity: "show" }).mockRejectedValueOnce(Error("failed"));
  await expect(observePreferredSeats([candidate, { ...candidate, performanceId: "other" }], m.repo, get, true, now)).rejects.toThrow("failed");
  expect(m.repo.storeSeatObservation).not.toHaveBeenCalled();
  m.observations.set("test", { available: [], identity: "old-show", policy: SEAT_POLICY, revision: 1, observedAt: now.toISOString() });
  await observePreferredSeats([candidate], m.repo, async () => ({ available: ["H10"], identity: "new-show" }), true, now);
  expect(m.events).toEqual([]);
});
it("skips weekdays, missing firstSeen and already-started shows", async () => {
  const m = memoryMonitor(); const get = vi.fn(async () => ({ available: [], identity: "show" }));
  const weekday = { ...candidate, displayDate: "2026-09-11", displayTime: "18:00" };
  await observePreferredSeats([weekday], m.repo, get, true, now);
  expect(get).not.toHaveBeenCalled();
  await observePreferredSeats([candidate], m.repo, get, true, new Date("2026-09-12T18:00:00+09:00"));
  expect(get).not.toHaveBeenCalled();
  m.firstSeen.clear(); await observePreferredSeats([candidate], m.repo, get, true, now);
  expect(get).not.toHaveBeenCalled();
});
it("does not notify during disabled mode", async () => {
  const m = memoryMonitor();
  m.observations.set("test", { available: [], identity: "show", policy: SEAT_POLICY, revision: 1, observedAt: now.toISOString() });
  await observePreferredSeats([candidate], m.repo, async () => ({ available: ["H10"], identity: "show" }), false, now);
  expect(m.events).toEqual([]); expect(m.observations.get("test")?.available).toEqual(["H10"]);
});
it("formats 60-character seat lines with omitted seat count, not range count", () => {
  const labels = ["G10","G11","G20","G21","G22","G23","H10","H11","H20","H21","H22","I20","I21","I22","J22","J23","K21","L24"];
  expect(formatReleasedSeats(labels)).toBe("🪑 G10–G11 · G20–G23 · H10–H11 · H20–H22 · I20–I22 · +4석");
  expect([...formatReleasedSeats(labels)].length).toBeLessThanOrEqual(60);
  expect(formatReleasedSeats(["H11", "H10", "H10", "H14"])).toBe("🪑 H10–H11 · H14");
});
it("separates opening/release messages, sorts dates and times, uses seats→time→book with only headings bold", () => {
  const groups = groupNotifications([
    { ...candidate, attempts: 0 },
    { ...candidate, displayDate: "2026-09-13", attempts: 0, releasedSeatLabels: ["J22"] },
    { ...candidate, displayTime: "21:30", attempts: 0, releasedSeatLabels: ["H11"] },
    { ...candidate, attempts: 0, releasedSeatLabels: ["H10"] },
  ]);
  expect(groups).toHaveLength(2);
  const opening = buildTelegramPayload("test", groups.find(g => g.sessions[0].releasedSeatLabels === undefined)!).text;
  expect(opening).not.toContain("🕒");
  expect(opening).toContain("<b>⭐ 신규 일정 오픈</b>\n\n<b>🎬 오디세이</b>\n📍 CGV 용산아이파크몰 IMAX관\n\n");
  const release = buildTelegramPayload("test", groups.find(g => g.sessions[0].releasedSeatLabels !== undefined)!).text;
  expect(release).toContain("<b>🔔 선호 좌석 오픈</b>");
  expect(release).toContain("📍 CGV 용산아이파크몰 IMAX관\n\n");
  expect(release).toContain("🪑 H10\n🕒 <code>18:00</code>\n🎫 <a");
  expect(release.indexOf("18:00")).toBeLessThan(release.indexOf("21:30"));
  expect(release.indexOf("9월 12일")).toBeLessThan(release.indexOf("9월 13일"));
  expect([...release.matchAll(/<b>(.*?)<\/b>/g)].every(m => /^[🔔🎬🗓]/u.test(m[1]))).toBe(true);
});
it("splits large same-day release messages within text and entity budgets", () => {
  const groups = groupNotifications(Array.from({ length: 180 }, (_, i) => ({ ...candidate, performanceId: String(i), attempts: 0, releasedSeatLabels: ["H10", "H11"] })));
  expect(groups.length).toBeGreaterThan(1); expect(groups.flatMap(g => g.sessions)).toHaveLength(180);
  for (const g of groups) { const p = buildTelegramPayload("test", g).text; expect(p.replace(/<[^>]*>/g, "").length).toBeLessThanOrEqual(4096); expect((p.match(/<(?:b|code|a)(?:>| )/g) ?? []).length).toBeLessThanOrEqual(90); }
});
it("links each movie and date independently in opening and preferred-seat alerts", () => {
  const notifications = [
    { ...candidate, attempts: 0 },
    { ...candidate, displayDate: "2026-09-13", attempts: 0 },
    { ...candidate, title: "다른 영화", movieNo: "30009999", attempts: 0 },
    { ...candidate, movieNo: "30008888", attempts: 0 }, // Same title, different code.
    { ...candidate, attempts: 0, releasedSeatLabels: ["K16"] },
  ];
  const groups = groupNotifications(notifications);
  expect(groups).toHaveLength(4);
  for (const group of groups) {
    const html = buildTelegramPayload("test", group).text;
    const links = [...html.matchAll(/href="([^"]+)"/g)].map(m => new URL(m[1].replaceAll("&amp;", "&")));
    expect(links.map(u => u.searchParams.get("scnYmd"))).toEqual([...new Set(group.sessions.map(s => s.displayDate.replaceAll("-", "")))]);
    for (const link of links) {
      expect(link.pathname).toBe("/cnm/movieBook/movie");
      expect(link.searchParams.get("movNo")).toBe(group.sessions[0].movieNo);
      expect(link.searchParams.get("siteNo")).toBe("0013");
      expect(link.searchParams.get("siteNm")).toBe("용산아이파크몰");
    }
  }
});
it("never queries first/last shows or legacy candidates without boundary metadata", async () => {
  const m = memoryMonitor(), get = vi.fn(async () => ({ available: [], identity: "show" }));
  await observePreferredSeats([{ ...candidate, isDayBoundary: true }, { ...candidate, isDayBoundary: undefined }], m.repo, get, true, now);
  expect(get).not.toHaveBeenCalled();
  await observePreferredSeats([candidate], m.repo, get, true, now);
  expect(get).toHaveBeenCalledOnce();
});
