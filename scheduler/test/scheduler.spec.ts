import { env } from "cloudflare:workers";
import { reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker, { dispatchWorkflow } from "../src/index";
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  fetcher.mockReset().mockImplementation(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => { await reset(); vi.unstubAllGlobals(); });

it("dispatches at cron and 30s alarm; deduplicates cron and alarm using durable storage", async () => {
  const stub = env.SCHEDULER.getByName("test-cron");
  const now = Date.now();
  await stub.tick(now);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const alarm = await runInDurableObject(stub, async (_obj, state) => state.storage.getAlarm());
  expect(alarm! - now).toBeGreaterThanOrEqual(30_000);
  expect(alarm! - now).toBeLessThan(31_000);
  await stub.tick(now);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await runInDurableObject(stub, (_obj, state) => {
    state.storage.sql.exec("UPDATE slots SET due = ? WHERE id LIKE '%:alarm'", Date.now() - 1);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(4);
  await runInDurableObject(stub, obj => obj.alarm());
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/schedule.yml/"))).toHaveLength(2);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/seats.yml/"))).toHaveLength(2);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ ref: "main", inputs: { dry_run: "true" } });
});

it("a failed cron request is not replayed and still leaves a 30-second alarm", async () => {
  fetcher.mockRejectedValueOnce(Error("network timeout"));
  const stub = env.SCHEDULER.getByName("failed");
  const now = Date.now();
  await stub.tick(now);
  const status = await runInDurableObject(stub, (_obj, state) => state.storage.sql.exec<{ status: string }>("SELECT status FROM slots WHERE id LIKE '%:cron'").one().status);
  expect(status).toBe("failed");
  await stub.tick(now);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const alarm = await runInDurableObject(stub, async (_obj, state) => state.storage.getAlarm());
  expect(alarm).not.toBeNull();
});

it("expired alarms and stale cron events do not enqueue old work", async () => {
  const stub = env.SCHEDULER.getByName("expired");
  await stub.tick(Date.now() - 61_000);
  expect(fetcher).not.toHaveBeenCalled();
  await stub.tick(Date.now());
  await runInDurableObject(stub, (_obj, state) => {
    state.storage.sql.exec("UPDATE slots SET due = 0, expires = 0 WHERE id LIKE '%:alarm'");
  });
  await runDurableObjectAlarm(stub);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("rejects missing credentials and non-success HTTP responses", async () => {
  await expect(dispatchWorkflow({ ...env, GITHUB_TOKEN: "" }, "test", fetcher)).rejects.toThrow("credential");
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(dispatchWorkflow(env, "test", fetcher)).rejects.toThrow("HTTP 401");
});

it("does not expose an HTTP trigger", () => {
  expect(worker.fetch().status).toBe(404);
});
