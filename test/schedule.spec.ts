import { afterEach, expect, it, vi } from "vitest";
import { parseRows } from "../src/collectors/cgv-model";
import { makeSchedulePayload, validateSchedulePayload } from "../src/core/schedule-payload";
import { deliverChangedSchedule } from "../src/core/schedule-delivery";
const now = new Date("2026-09-17T06:00:00Z");
const sessions = parseRows([{ title: "영화", screen: "IMAX", format: "IMAX", time: "18:00", status: "예매 가능", disabled: false }], "2026-09-18").map(s => ({ ...s, movieNo: "12345" }));
const schedule = { dates: ["2026-09-18", "2026-09-19"], sessions };
afterEach(() => vi.useRealTimers());
it("hashes complete schedule independent of date order, timestamps and seat availability", () => {
  const p = makeSchedulePayload(schedule, now);
  expect(makeSchedulePayload({ ...schedule, dates: [...schedule.dates].reverse(), seatCandidates: [] }).hash).toBe(p.hash);
  expect(makeSchedulePayload({ ...schedule, sessions: [] }, now).hash).not.toBe(p.hash);
  expect(validateSchedulePayload(p, now)).toEqual(p);
});
it("rejects stale, forged identity, duplicate, malformed, and hash-corrupted schedules", () => {
  const p = makeSchedulePayload(schedule, now);
  expect(() => validateSchedulePayload(p, new Date(now.getTime() + 180001))).toThrow("stale");
  expect(() => validateSchedulePayload({ ...p, hash: "bad" }, now)).toThrow("hash");
  for (const bad of [
    { ...schedule, dates: [] },
    { ...schedule, sessions: [...sessions, ...sessions] },
    { ...schedule, sessions: [{ ...sessions[0], performanceId: "forged" }] },
    { ...schedule, sessions: [{ ...sessions[0], bookingUrl: "https://example.com" }] },
  ]) expect(() => validateSchedulePayload(makeSchedulePayload(bad, now), now)).toThrow();
});
it("unchanged hashes never invoke Lambda; failures and dry runs never acknowledge state", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const p = makeSchedulePayload(schedule, now), invoke = vi.fn(), save = vi.fn();
  await deliverChangedSchedule(p, { version: 1, hash: p.hash }, invoke, save);
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockRejectedValueOnce(Error("timeout"));
  await expect(deliverChangedSchedule(p, { version: 1 }, invoke, save)).rejects.toThrow("timeout");
  invoke.mockResolvedValueOnce({ accepted: true, hash: "wrong", dryRun: false });
  await expect(deliverChangedSchedule(p, { version: 1 }, invoke, save)).rejects.toThrow("acknowledge");
  invoke.mockResolvedValueOnce({ accepted: true, hash: p.hash, dryRun: true });
  await deliverChangedSchedule(p, { version: 1 }, invoke, save, true);
  expect(save).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce({ accepted: true, hash: p.hash, dryRun: false });
  await deliverChangedSchedule(p, { version: 1 }, invoke, save);
  expect(save).toHaveBeenCalledWith({ version: 1, hash: p.hash, observedAt: p.observedAt });
});
