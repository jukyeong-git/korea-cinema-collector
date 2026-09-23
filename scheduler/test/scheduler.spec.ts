import { env } from "cloudflare:workers";
import { reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker, { enabled, invokeLambda, targets } from "../src/index";
const fetcher = vi.fn<typeof fetch>();
let clock: number;
beforeEach(() => {
  clock = Math.floor(Date.now() / 60_000) * 60_000 + 3_600_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  fetcher.mockReset().mockImplementation(async () => new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => { await reset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("calls schedule and Friday to Sunday seats every 20s, Monday to Thursday every 30s", async () => {
  const stub = env.SCHEDULER.getByName("cadence");
  const start = clock;
  await stub.tick(start);
  expect(fetcher).toHaveBeenCalledTimes(8);
  for (const second of [20, 30, 40]) {
    expect(await runInDurableObject(stub, (_obj, state) => state.storage.getAlarm())).toBe(start + second * 1000);
    clock = start + second * 1000;
    await runDurableObjectAlarm(stub);
    const count = fetcher.mock.calls.length;
    await runInDurableObject(stub, obj => obj.alarm());
    await stub.tick(start);
    expect(fetcher).toHaveBeenCalledTimes(count);
  }
  for (const target of targets) expect(fetcher.mock.calls.filter(([req]) => (req as Request).url.includes(`korea-cinema-alert-${target}/`))).toHaveLength(["schedule", "seats-05", "seats-06", "seats-07"].includes(target) ? 3 : 2);
  const req = fetcher.mock.calls[0][0] as Request;
  expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
  expect(req.headers.get("x-amz-invocation-type")).toBe("Event");
  clock = start + 60_000;
  await Promise.all([stub.tick(clock), runInDurableObject(stub, obj => obj.alarm())]);
  expect(fetcher.mock.calls.filter(([req]) => (req as Request).url.includes("alert-schedule/"))).toHaveLength(4);
});

it("continues after invoke failure without retrying the same slot", async () => {
  const stub = env.SCHEDULER.getByName("failed");
  await stub.tick(clock);
  fetcher.mockRejectedValueOnce(Error("network timeout"));
  clock += 20_000;
  await runDurableObjectAlarm(stub);
  expect(fetcher).toHaveBeenCalledTimes(12);
  await runInDurableObject(stub, obj => obj.alarm());
  expect(fetcher).toHaveBeenCalledTimes(12);
  expect(await runInDurableObject(stub, (_obj, state) => state.storage.getAlarm())).toBe(clock + 10_000);
  clock += 10_000;
  await runDurableObjectAlarm(stub);
  expect(fetcher).toHaveBeenCalledTimes(16);
  clock += 10_000;
  await runDurableObjectAlarm(stub);
  expect(fetcher).toHaveBeenCalledTimes(20);
});

it("collapses missed intervals and keeps fixed boundaries without cron", async () => {
  const stub = env.SCHEDULER.getByName("late");
  await stub.tick(clock);
  clock += 72_000;
  await runDurableObjectAlarm(stub);
  expect(fetcher).toHaveBeenCalledTimes(12);
  expect(await runInDurableObject(stub, (_obj, state) => state.storage.getAlarm())).toBe(clock + 8_000);
});

it("cron repairs a missing alarm without duplicating the current slot", async () => {
  const stub = env.SCHEDULER.getByName("recover");
  const start = clock;
  await stub.tick(start);
  await runInDurableObject(stub, (_obj, state) => state.storage.deleteAlarm());
  clock += 22_000;
  await stub.tick(start);
  expect(fetcher).toHaveBeenCalledTimes(12);
  expect(await runInDurableObject(stub, (_obj, state) => state.storage.getAlarm())).toBe(start + 30_000);
});

it("ignores stale cron and retires legacy schedule alarms on upgrade", async () => {
  const stub = env.SCHEDULER.getByName("legacy");
  await stub.tick(clock - 61_000);
  expect(fetcher).not.toHaveBeenCalled();
  await runInDurableObject(stub, (_obj, state) => {
    state.storage.sql.exec("INSERT INTO slots VALUES ('old:schedule:alarm', ?, ?, 'pending')", clock, clock + 60_000);
  });
  await stub.tick(clock);
  await runInDurableObject(stub, obj => obj.alarm());
  expect(fetcher).toHaveBeenCalledTimes(8);
  expect(await runInDurableObject(stub, (_obj, state) => state.storage.sql.exec<{status: string}>("SELECT status FROM slots WHERE id = 'old:schedule:alarm'").one().status)).toBe("skipped");
});

it("rejects missing credentials and non-202 responses without retries", async () => {
  await expect(invokeLambda({ ...env, AWS_ACCESS_KEY_ID: "" }, "schedule", "test", fetcher)).rejects.toThrow("credential");
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(invokeLambda(env, "schedule", "test", fetcher)).rejects.toThrow("HTTP 403");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([["true", "true", 8], ["true", "false", 1], ["false", "true", 7], ["false", "false", 0]])("supports independent switches %s/%s", (schedule, seats, count) => {
  const config = { ...env, SCHEDULE_ENABLED: String(schedule), SEATS_ENABLED: String(seats) };
  expect(targets.filter(t => enabled(config, t))).toHaveLength(Number(count));
  expect(targets.filter(t => enabled({ ...config, ENABLED: "false" }, t))).toHaveLength(0);
});

it("does not expose an HTTP trigger", () => { expect(worker.fetch().status).toBe(404); });


it("retires old weekend slots and does not invoke disabled fast targets", async () => {
  const stub = env.SCHEDULER.getByName("weekend-upgrade");
  await runInDurableObject(stub, (_obj, state) => {
    for (const target of ["seats-05", "seats-06", "seats-07"]) state.storage.sql.exec("INSERT INTO slots VALUES (?, ?, ?, 'pending')", `old:${target}:alarm`, clock + 30_000, clock + 60_000);
  });
  await stub.tick(clock);
  expect(await runInDurableObject(stub, (_obj, state) => state.storage.sql.exec<{ count: number }>("SELECT count(*) as count FROM slots WHERE id LIKE 'old:%' AND status = 'skipped'").one().count)).toBe(3);
  const saved = env.SEATS_ENABLED;
  try {
    env.SEATS_ENABLED = "false";
    clock += 20_000;
    await runDurableObjectAlarm(stub);
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect((fetcher.mock.calls.at(-1)![0] as Request).url).toContain("alert-schedule/");
  } finally { env.SEATS_ENABLED = saved; }
});
