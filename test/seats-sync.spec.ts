import { expect, it, vi } from "vitest";
import { runSeatsSync } from "../src/core/seats-sync";
import type { SeatCandidate, PendingNotification } from "../src/core/types";
import type { SessionRepository } from "../src/core/session-repository";
const c: SeatCandidate = { performanceId: "show", isDayBoundary: false, title: "영화", movieNo: "123", displayDate: "2099-01-03", displayTime: "18:00", venue: "IMAX관", formatCode: "IMAX", subtitleCode: null, bookingUrl: "", seatQuery: { coCd: "A420", siteNo: "0013", scnYmd: "20990103", scnsNo: "018", scnSseq: "1" } };
it("seat worker sends only freshly available seat events, never opening events", async () => {
  const pending: PendingNotification[] = [{ ...c, attempts: 0 }, { ...c, attempts: 1, notificationId: "SEATOPEN#show#2", releasedSeatLabels: ["H10", "H11"] }];
  const repository = { listPending: vi.fn(async () => pending), markSent: vi.fn(), markFailed: vi.fn() } as unknown as SessionRepository;
  const sendNotification = vi.fn();
  const result = await runSeatsSync({ repository, sendNotification, observeSeats: vi.fn(), currentAvailableSeats: new Map([["show", ["H11"]]]) }, [c]);
  expect(result.notificationsSent).toBe(1);
  expect(sendNotification.mock.calls[0][0].sessions[0].releasedSeatLabels).toEqual(["H11"]);
  expect(repository.markSent).toHaveBeenCalledWith(["SEATOPEN#show#2"], expect.any(String));
});
it("failed seat observation leaves pending notifications untouched", async () => {
  const listPending = vi.fn(), sendNotification = vi.fn();
  await expect(runSeatsSync({ repository: { listPending } as unknown as SessionRepository, sendNotification,
    observeSeats: async () => { throw Error("429"); } }, [c])).rejects.toThrow("429");
  expect(listPending).not.toHaveBeenCalled(); expect(sendNotification).not.toHaveBeenCalled();
});
it("weekday shards observe and deliver only their own days without discarding other shards", async () => {
  const monday = { ...c, performanceId: "monday", displayDate: "2099-01-05" };
  const pending = [c, monday].map(item => ({ ...item, attempts: 0, notificationId: `SEATOPEN#${item.performanceId}`, releasedSeatLabels: ["H10"] }));
  const discardNotification = vi.fn(), markSent = vi.fn(), observeSeats = vi.fn(), sendNotification = vi.fn();
  const repository = { listPending: async () => pending, discardNotification, markSent, markFailed: vi.fn() } as unknown as SessionRepository;
  await runSeatsSync({ repository, observeSeats, sendNotification, currentAvailableSeats: new Map([["show", ["H10"]], ["monday", ["H10"]]]) }, [c, monday], new Date("2098-12-01"), [1, 2]);
  expect(observeSeats).toHaveBeenCalledWith([monday], true);
  expect(markSent).toHaveBeenCalledWith(["SEATOPEN#monday"], expect.any(String));
  expect(discardNotification).not.toHaveBeenCalled();
});
it("muted seat alerts discard pending seat events without discarding schedule notifications", async () => {
  const discardNotification = vi.fn(), sendNotification = vi.fn(), observeSeats = vi.fn();
  const repository = { listPending: async () => [
    { ...c, attempts: 0 },
    { ...c, attempts: 0, notificationId: "SEATOPEN#show#1", releasedSeatLabels: ["H10"] },
  ], discardNotification } as unknown as SessionRepository;
  await runSeatsSync({ repository, observeSeats, sendNotification, notificationsEnabled: false }, [c]);
  expect(observeSeats).toHaveBeenCalledWith([c], false);
  expect(discardNotification).toHaveBeenCalledExactlyOnceWith("SEATOPEN#show#1", expect.any(String));
  expect(sendNotification).not.toHaveBeenCalled();
});
