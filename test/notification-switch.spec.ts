import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class { send = mocks.send }, GetParametersCommand: class { constructor(public input: any) {} } }));
import { readNotificationSwitch } from "../src/platform/aws/notification-switch";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it.each([[true, true], [true, false], [false, true], [false, false]])("reads independent switches: schedule=%s seats=%s", async (schedule, seats) => {
  const values: Record<string, string> = { schedule: String(schedule), seats: String(seats) };
  mocks.send.mockImplementation(async command => ({ Parameters: command.input.Names.map((Name: string) => ({ Name, Value: values[Name] })) }));
  vi.stubEnv("NOTIFICATION_SWITCH_PARAMETER", "schedule"); expect(await readNotificationSwitch()).toBe(schedule);
  vi.stubEnv("NOTIFICATION_SWITCH_PARAMETER", "seats"); expect(await readNotificationSwitch()).toBe(seats);
  values.seats = String(!seats); expect(await readNotificationSwitch()).toBe(!seats);
});
it("does not default to ON for missing, invalid, or unreadable switches", async () => {
  vi.stubEnv("NOTIFICATION_SWITCH_PARAMETER", "switch");
  for (const value of [undefined, "yes", "TRUE", ""]) {
    mocks.send.mockResolvedValue({ Parameters: [{ Name: "switch", Value: value }] });
    await expect(readNotificationSwitch()).rejects.toThrow("invalid");
  }
  mocks.send.mockRejectedValue(Error("SSM unavailable"));
  await expect(readNotificationSwitch()).rejects.toThrow("SSM unavailable");
});
