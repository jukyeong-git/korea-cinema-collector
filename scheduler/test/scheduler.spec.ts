import { env } from "cloudflare:workers";
import { reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker, { enabled, invokeLambda, targets } from "../src/index";
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  fetcher.mockReset().mockImplementation(async () => new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => { await reset(); vi.unstubAllGlobals(); });

it("invokes all five collectors at cron and 30s alarm, deduplicating redelivery", async () => {
  const stub = env.SCHEDULER.getByName("test-cron");
  const now = Date.now();
  await stub.tick(now);
  expect(fetcher).toHaveBeenCalledTimes(5);
  const alarm = await runInDurableObject(stub, async (_obj, state) => state.storage.getAlarm());
  expect(alarm! - now).toBeGreaterThanOrEqual(30_000);
  expect(alarm! - now).toBeLessThan(31_000);
  await stub.tick(now);
  expect(fetcher).toHaveBeenCalledTimes(5);
  await runInDurableObject(stub, (_obj, state) => {
    state.storage.sql.exec("UPDATE slots SET due = ? WHERE id LIKE '%:alarm'", Date.now() - 1);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(10);
  await runInDurableObject(stub, obj => obj.alarm());
  expect(fetcher).toHaveBeenCalledTimes(10);
  for (const target of targets) expect(fetcher.mock.calls.filter(([req]) => (req as Request).url.includes(`korea-cinema-alert-${target}/`))).toHaveLength(2);
  const req = fetcher.mock.calls[0][0] as Request;
  expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
  expect(req.headers.get("x-amz-invocation-type")).toBe("Event");
  expect(await runInDurableObject(stub, () => req.json())).toMatchObject({ source: "cloudflare-scheduler", slot: expect.stringContaining(":cron") });
});

it("an immediate network failure does not suppress other collectors or the alarm", async () => {
  fetcher.mockRejectedValueOnce(Error("network timeout"));
  const stub = env.SCHEDULER.getByName("failed");
  const now = Date.now();
  await stub.tick(now);
  const count = await runInDurableObject(stub, (_obj, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM slots WHERE status = 'failed'").one().n);
  expect(count).toBe(1);
  await stub.tick(now);
  expect(fetcher).toHaveBeenCalledTimes(5);
  await runInDurableObject(stub, (_obj, state) => state.storage.sql.exec("UPDATE slots SET due = 0 WHERE id LIKE '%:alarm'"));
  await runDurableObjectAlarm(stub);
  expect(fetcher).toHaveBeenCalledTimes(10);
});

it("expired alarms and stale cron events do not enqueue old work", async () => {
  const stub = env.SCHEDULER.getByName("expired");
  await stub.tick(Date.now() - 61_000);
  expect(fetcher).not.toHaveBeenCalled();
  await stub.tick(Date.now());
  await runInDurableObject(stub, (_obj, state) => state.storage.sql.exec("UPDATE slots SET due = 0, expires = 0 WHERE id LIKE '%:alarm'"));
  await runDurableObjectAlarm(stub);
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it("rejects missing credentials and non-202 responses without retries", async () => {
  await expect(invokeLambda({ ...env, AWS_ACCESS_KEY_ID: "" }, "schedule", "test", fetcher)).rejects.toThrow("credential");
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(invokeLambda(env, "schedule", "test", fetcher)).rejects.toThrow("HTTP 403");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([["true", "true", 5], ["true", "false", 1], ["false", "true", 4], ["false", "false", 0]])("supports independent switches %s/%s", (schedule, seats, count) => {
  const config = { ...env, SCHEDULE_ENABLED: String(schedule), SEATS_ENABLED: String(seats) };
  expect(targets.filter(t => enabled(config, t))).toHaveLength(Number(count));
  expect(targets.filter(t => enabled({ ...config, ENABLED: "false" }, t))).toHaveLength(0);
});

it("does not expose an HTTP trigger", () => { expect(worker.fetch().status).toBe(404); });
