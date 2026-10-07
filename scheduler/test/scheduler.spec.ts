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

it("calls schedule every 5s and all seven seat workers every 60s", async () => {
  const stub = env.SCHEDULER.getByName("cadence");
  const start = clock;
  await stub.tick(start);
  expect(fetcher).toHaveBeenCalledTimes(8);
  for (const second of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]) {
    expect(await runInDurableObject(stub, (_obj, state) => state.storage.getAlarm())).toBe(start + second * 1000);
    clock = start + second * 1000;
    await runDurableObjectAlarm(stub);
    const count = fetcher.mock.calls.length;
    await runInDurableObject(stub, obj => obj.alarm());
    await stub.tick(start);
    expect(fetcher).toHaveBeenCalledTimes(count);
  }
  for (const target of targets) expect(fetcher.mock.calls.filter(([req]) => (req as Request).url.includes(`aws-korea-cinema-alert-${target === "schedule" ? "schedules" : target}/`))).toHaveLength(target === "schedule" ? 12 : 1);
  const req = fetcher.mock.calls[0][0] as Request;
  expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
  expect(req.headers.get("x-amz-invocation-type")).toBe("Event");
  clock = start + 60_000;
  await Promise.all([stub.tick(clock), runInDurableObject(stub, obj => obj.alarm())]);
  expect(fetcher.mock.calls.filter(([req]) => (req as Request).url.includes("alert-schedules/"))).toHaveLength(13);
  for (const target of targets.filter(target => target !== "schedule")) {
    const calls = fetcher.mock.calls.filter(([req]) => (req as Request).url.includes(`alert-${target}/`));
    expect(calls).toHaveLength(2);
  }
});

it("continues after invoke failure without retrying the same slot", async () => {
  const stub = env.SCHEDULER.getByName("failed");
  await stub.tick(clock);
  fetcher.mockRejectedValueOnce(Error("network timeout"));
  clock += 20_000;
  await runDurableObjectAlarm(stub);
  expect(fetcher).toHaveBeenCalledTimes(9);
  await runInDurableObject(stub, obj => obj.alarm());
  expect(fetcher).toHaveBeenCalledTimes(9);
  expect(await runInDurableObject(stub, (_obj, state) => state.storage.getAlarm())).toBe(clock + 5_000);
  clock += 10_000;
  await runDurableObjectAlarm(stub);
  expect(fetcher).toHaveBeenCalledTimes(10);
  clock += 10_000;
  await runDurableObjectAlarm(stub);
  expect(fetcher).toHaveBeenCalledTimes(11);
});

it("collapses missed intervals and keeps fixed boundaries without cron", async () => {
  const stub = env.SCHEDULER.getByName("late");
  await stub.tick(clock);
  clock += 72_000;
  await runDurableObjectAlarm(stub);
  expect(fetcher).toHaveBeenCalledTimes(16);
  expect(await runInDurableObject(stub, (_obj, state) => state.storage.getAlarm())).toBe(clock + 3_000);
});

it("cron repairs a missing alarm without duplicating the current slot", async () => {
  const stub = env.SCHEDULER.getByName("recover");
  const start = clock;
  await stub.tick(start);
  await runInDurableObject(stub, (_obj, state) => state.storage.deleteAlarm());
  clock += 22_000;
  await stub.tick(start);
  expect(fetcher).toHaveBeenCalledTimes(9);
  expect(await runInDurableObject(stub, (_obj, state) => state.storage.getAlarm())).toBe(start + 25_000);
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
    expect((fetcher.mock.calls.at(-1)![0] as Request).url).toContain("alert-schedules/");
  } finally { env.SEATS_ENABLED = saved; }
});

it('dispatches without delaying behind an active run; GitHub concurrency queues it', async () => {
  const { dispatchScheduleWorkflow } = await import('../src/index');
  fetcher.mockResolvedValueOnce(new Response(null,{status:204}));
  expect(await dispatchScheduleWorkflow({...env,GITHUB_TOKEN:'test'},fetcher)).toBe('started');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0][0])).toContain('/schedule.yml/dispatches');
});
it('dispatches every hourly cron event regardless of timestamp or prior dispatch', async () => {
  fetcher.mockImplementation(async () => new Response(null,{status:204}));
  const config = {...env,GITHUB_SCHEDULE_ENABLED:'true'};
  for (const time of [clock + 23000,clock - 600000,clock + 23000]) {
    await worker.scheduled({cron:'0 * * * *',scheduledTime:time} as ScheduledController,config);
  }
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.every(([url]) => String(url).includes('/schedule.yml/dispatches'))).toBe(true);
  await worker.scheduled({cron:'0 * * * *',scheduledTime:clock} as ScheduledController,{...config,GITHUB_SCHEDULE_ENABLED:'false'});
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('Monday GitHub switch disables only the Monday direct collector', () => {
  const config = {...env, ENABLED:'true', SEATS_ENABLED:'true', GITHUB_SEATS01_ENABLED:'true'};
  expect(enabled(config,'seats-01')).toBe(false);
  expect(enabled(config,'seats-02')).toBe(true);
  expect(enabled(config,'seats-07')).toBe(true);
});
it('hourly cron dispatches Monday and schedule workflows independently', async () => {
  fetcher.mockResolvedValue(new Response(null,{status:204}));
  await worker.scheduled({cron:'0 * * * *',scheduledTime:clock,noRetry(){}}, {...env,ENABLED:'true',GITHUB_SCHEDULE_ENABLED:'true',GITHUB_SEATS01_ENABLED:'true',GITHUB_TOKEN:'test'});
  expect(fetcher.mock.calls.map(([url])=>String(url))).toEqual(expect.arrayContaining([
    expect.stringContaining('/schedule.yml/dispatches'),expect.stringContaining('/seats-01.yml/dispatches'),
  ]));
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('all weekday migration flags retire direct collectors and dispatch seven independent workflows',async()=>{
 const flags={GITHUB_SEATS01_ENABLED:'true',GITHUB_SEATS02_ENABLED:'true',GITHUB_SEATS03_ENABLED:'true',GITHUB_SEATS04_ENABLED:'true',GITHUB_SEATS05_ENABLED:'true',GITHUB_SEATS06_ENABLED:'true',GITHUB_SEATS07_ENABLED:'true'};
 const config={...env,...flags,ENABLED:'true',SEATS_ENABLED:'true',GITHUB_SCHEDULE_ENABLED:'true',GITHUB_TOKEN:'test'};
 for(const target of targets.filter(t=>t.startsWith('seats-')))expect(enabled(config,target)).toBe(false);
 fetcher.mockResolvedValue(new Response(null,{status:204}));
 await worker.scheduled({cron:'0 * * * *',scheduledTime:clock,noRetry(){}},config);
 expect(fetcher).toHaveBeenCalledTimes(8);
 for(const shard of ['01','02','03','04','05','06','07'])expect(fetcher.mock.calls.some(([u])=>String(u).endsWith(`/seats-${shard}.yml/dispatches`))).toBe(true);
});

it('does not dispatch any GitHub workflows when all migration switches are off', async () => {
  await worker.scheduled({cron:'0 * * * *',scheduledTime:clock,noRetry(){}}, {...env, GITHUB_SCHEDULE_ENABLED:'false', GITHUB_SEATS01_ENABLED:'false', GITHUB_SEATS02_ENABLED:'false', GITHUB_SEATS03_ENABLED:'false', GITHUB_SEATS04_ENABLED:'false', GITHUB_SEATS05_ENABLED:'false', GITHUB_SEATS06_ENABLED:'false', GITHUB_SEATS07_ENABLED:'false'});
  expect(fetcher).not.toHaveBeenCalled();
});


it("pauses Monday AWS without enabling GitHub or pausing other targets", async () => {
  const saved = env.AWS_SEATS01_ENABLED;
  try {
    env.AWS_SEATS01_ENABLED = "false";
    const stub = env.SCHEDULER.getByName("monday-paused");
    await stub.tick(clock);
    clock += 30_000;
    await runDurableObjectAlarm(stub);
    const urls = fetcher.mock.calls.map(([req]) => (req as Request).url);
    expect(urls.some(url => url.includes("alert-seats-01/"))).toBe(false);
    for (const target of targets.filter(t => t !== "seats-01")) {
      expect(urls.some(url => url.includes(`alert-${target === "schedule" ? "schedules" : target}/`))).toBe(true);
    }
    fetcher.mockClear();
    await worker.scheduled({cron:"0 * * * *",scheduledTime:clock} as ScheduledController, env);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { env.AWS_SEATS01_ENABLED = saved; }
});
