import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseRows } from "../src/collectors/cgv-model";
import { makeSchedulePayload } from "../src/core/schedule-payload";
const mocks = vi.hoisted(() => ({ repository: {} as any, send: vi.fn(), ssm: vi.fn(), lease: vi.fn(), busy: false }));
vi.mock("../src/platform/aws/dynamodb-session-repository", () => ({ createDynamoDbSessionRepository: () => mocks.repository }));
vi.mock("../src/platform/aws/sync-lease", () => ({ withSyncLease: (...args: any[]) => mocks.lease(...args) }));
vi.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class { send = mocks.ssm }, GetParametersCommand: class { constructor(public input: unknown) {} } }));
vi.mock("../src/core/telegram", async original => ({ ...await original<typeof import("../src/core/telegram")>(), sendTelegramGroup: mocks.send }));
import { handler } from "../src/platform/aws/schedule-receiver";
const now = new Date("2026-09-17T06:00:00Z");
const sessions = parseRows([{ title: "영화", screen: "IMAX", format: "IMAX", time: "18:00", status: "예매 가능", disabled: false }], "2026-09-18").map(s => ({ ...s, movieNo: "12345" }));
const payload = () => makeSchedulePayload({ dates: ["2026-09-18"], sessions }, now);
let pending: any[], known: Set<string>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks(); mocks.busy = false;
  process.env.TABLE_NAME = "test"; process.env.ALERTS_ENABLED = "true";
  process.env.TELEGRAM_BOT_TOKEN_PARAMETER = "token"; process.env.TELEGRAM_CHAT_ID_PARAMETER = "schedule-chat";
  mocks.ssm.mockResolvedValue({ Parameters: [{ Name: "token", Value: "fake" }, { Name: "schedule-chat", Value: "original-channel" }] });
  mocks.send.mockResolvedValue(undefined);
  mocks.lease.mockImplementation(async (_table, work) => mocks.busy ? { skipped: true } : work());
  pending = []; known = new Set();
  mocks.repository = {
    isInitialized: vi.fn(async () => true),
    listKnownPerformanceIds: vi.fn(async () => known),
    storeNewSessions: vi.fn(async (items, _now, notify) => { for (const s of items) { known.add(s.performanceId); if (notify) pending.push({ ...s, attempts: 0 }); } return items.length; }),
    listPending: vi.fn(async () => pending), markSent: vi.fn(async () => { pending = []; }), markFailed: vi.fn(), markInitialized: vi.fn(),
  };
});
afterEach(() => vi.useRealTimers());
it("compares DynamoDB, sends the existing schedule format/channel and deduplicates repeated JSON", async () => {
  expect(await handler(payload())).toMatchObject({ accepted: true, newSessions: 1, notificationsSent: 1 });
  const [token, chat, group] = mocks.send.mock.calls[0];
  expect(chat).toBe("original-channel");
  const { buildTelegramPayload } = await import("../src/core/telegram");
  expect(buildTelegramPayload(chat, group).text).toContain("⭐ 신규 일정 오픈");
  expect(await handler(payload())).toMatchObject({ newSessions: 0, notificationsSent: 0 });
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(mocks.lease.mock.calls[0][3]).toBe("STATE#schedule_lease");
});
it("retries pending delivery after failure without inserting a duplicate session", async () => {
  mocks.send.mockRejectedValueOnce(Error("Telegram unavailable"));
  await expect(handler(payload())).rejects.toThrow("Telegram unavailable");
  expect(await handler(payload())).toMatchObject({ newSessions: 0, notificationsSent: 1 });
  expect(known.size).toBe(1);
});
it("dry run only reads DynamoDB and a busy legacy schedule lease is not acknowledged", async () => {
  expect(await handler({ ...payload(), dryRun: true })).toMatchObject({ dryRun: true, newSessions: 1 });
  expect(mocks.repository.storeNewSessions).not.toHaveBeenCalled();
  expect(mocks.lease).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  mocks.busy = true;
  await expect(handler(payload())).rejects.toThrow("busy");
});
it("missing baseline is initialized without historical notifications; malformed JSON is rejected first", async () => {
  mocks.repository.isInitialized.mockResolvedValue(false);
  expect(await handler(payload())).toMatchObject({ baselineCreated: true, notificationsSent: 0 });
  expect(mocks.repository.markInitialized).toHaveBeenCalledOnce();
  await expect(handler({ ...payload(), hash: "bad" })).rejects.toThrow("hash");
  expect(mocks.send).not.toHaveBeenCalled();
});
