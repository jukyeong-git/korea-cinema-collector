import { beforeEach, expect, it, vi } from "vitest";
import { makePayload } from "../src/core/seat-payload";
import { SEAT_POLICY, type SeatObservation } from "../src/core/seat-monitor";
import { seatIdentity } from "../src/collectors/cgv-seats";
import type { SeatCandidate, PendingNotification } from "../src/core/types";
const mocks = vi.hoisted(() => ({ repository: {} as any, send: vi.fn(), ssm: vi.fn(), busy: false }));
vi.mock("../src/platform/aws/dynamodb-session-repository", () => ({ createDynamoDbSessionRepository: () => mocks.repository }));
vi.mock("../src/platform/aws/sync-lease", () => ({ withSyncLease: async (_table: string, work: () => Promise<unknown>) => mocks.busy ? { skipped: true } : work() }));
vi.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class { send = mocks.ssm }, GetParametersCommand: class { constructor(public input: unknown) {} } }));
vi.mock("../src/core/telegram", async importOriginal => ({ ...await importOriginal<typeof import("../src/core/telegram")>(), sendTelegramGroup: mocks.send }));
import { handler } from "../src/platform/aws/receiver";
const now = new Date("2026-09-17T06:00:00Z");
const c: SeatCandidate = { performanceId: "show", title: "영화", displayDate: "2026-09-18", displayTime: "18:00", isDayBoundary: false,
  venue: "IMAX", formatCode: "IMAX", subtitleCode: null, bookingUrl: "", seatQuery: { coCd: "A420", siteNo: "0013", scnYmd: "20260918", scnsNo: "018", scnSseq: "3" } };
let observations: Map<string, SeatObservation>, pending: PendingNotification[];
const payload = () => makePayload([{ performanceId: c.performanceId, identity: seatIdentity(c), available: ["K16"] }], now);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks(); mocks.busy = false;
  process.env.NOTIFICATION_SWITCH_PARAMETER = "switch";
  process.env.TABLE_NAME = "test"; process.env.ALERTS_ENABLED = "true";
  process.env.TELEGRAM_BOT_TOKEN_PARAMETER = "token"; process.env.TELEGRAM_CHAT_ID_PARAMETER = "chat";
  mocks.ssm.mockResolvedValue({ Parameters: [{ Name: "switch", Value: "true" }, { Name: "token", Value: "fake" }, { Name: "chat", Value: "fake" }] });
  mocks.send.mockResolvedValue(undefined);
  observations = new Map([["show", { identity: seatIdentity(c), available: [], revision: 1, policy: SEAT_POLICY, observedAt: new Date(now.getTime() - 300000).toISOString() }]]);
  pending = [];
  mocks.repository = {
    readSeatCandidates: vi.fn(async () => [c]),
    loadSeatContext: vi.fn(async () => ({ firstSeen: new Map([["show", new Date(now.getTime() - 3600000).toISOString()]]), observations })),
    storeSeatObservation: vi.fn(async (candidate, snapshot, previous, stamp, labels) => {
      observations.set(candidate.performanceId, { ...snapshot, revision: previous.revision + 1, policy: SEAT_POLICY, observedAt: stamp });
      if (labels.length) pending.push({ ...candidate, notificationId: "SEATOPEN#show#2", releasedSeatLabels: labels, attempts: 0 });
      return true;
    }),
    listPending: vi.fn(async () => pending), markSent: vi.fn(async () => { pending = []; }), markFailed: vi.fn(), discardNotification: vi.fn(),
  };
});
it("detects releases against DynamoDB and repeated JSON does not resend", async () => {
  expect(await handler(payload())).toMatchObject({ accepted: true, notificationsSent: 1 });
  expect(mocks.send.mock.calls[0][2].sessions[0].releasedSeatLabels).toEqual(["K16"]);
  expect(await handler(payload())).toMatchObject({ accepted: true, notificationsSent: 0 });
  expect(mocks.send).toHaveBeenCalledOnce();
});
it("failed Telegram delivery remains pending and is retried without a second seat event", async () => {
  mocks.send.mockRejectedValueOnce(Error("Telegram unavailable"));
  await expect(handler(payload())).rejects.toThrow("Telegram unavailable");
  expect(await handler(payload())).toMatchObject({ accepted: true, notificationsSent: 1 });
  expect(mocks.repository.storeSeatObservation).toHaveBeenCalledOnce();
});
it("rejects stale schedule, partial JSON, future stored observation and concurrent writes without acknowledgement", async () => {
  await expect(handler(makePayload([], now))).rejects.toThrow("Incomplete");
  expect(mocks.repository.storeSeatObservation).not.toHaveBeenCalled();
  observations.get("show")!.observedAt = new Date(now.getTime() + 1).toISOString();
  await expect(handler(payload())).rejects.toThrow("Out-of-order");
  observations.get("show")!.observedAt = new Date(now.getTime() - 1000).toISOString();
  mocks.repository.storeSeatObservation.mockResolvedValue(false);
  await expect(handler(payload())).rejects.toThrow("Concurrent");
  mocks.repository.readSeatCandidates.mockResolvedValue(undefined);
  await expect(handler(payload())).rejects.toThrow("stale");
});
it("a busy lease is a retryable failure, never an accepted hash", async () => {
  mocks.busy = true;
  await expect(handler(payload())).rejects.toThrow("busy");
});
it("muting seats updates the snapshot without notifications, then resumes without replaying it", async () => {
  mocks.ssm.mockResolvedValue({ Parameters: [{ Name: "switch", Value: "false" }] });
  expect(await handler(payload())).toMatchObject({ accepted: true, notificationsEnabled: false, notificationsSent: 0 });
  expect(observations.get("show")!.available).toEqual(["K16"]);
  expect(mocks.send).not.toHaveBeenCalled();
  mocks.ssm.mockResolvedValue({ Parameters: [{ Name: "switch", Value: "true" }, { Name: "token", Value: "fake" }, { Name: "chat", Value: "fake" }] });
  expect(await handler(payload())).toMatchObject({ notificationsEnabled: true, notificationsSent: 0 });
  expect(mocks.send).not.toHaveBeenCalled();
});
