import { expect, it, vi } from "vitest";
import { fetchApiImaxSessions } from "../src/collectors/cgv-api";
import { publishScheduleSnapshot } from "../src/platform/aws/schedule-snapshot";
const now = () => new Date("2026-09-18T00:00:00Z");
const dates = ["20260918", "20260919", "20260920"];
function fetcher(failAll = false, status = 403) {
  return vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("searchSiteScnscYmdListBySite")) {
      return Response.json({ statusCode: 0, data: dates.map(scnYmd => ({ scnYmd })) });
    }
    if (failAll || url.searchParams.get("scnYmd") === dates[1]) return new Response("denied", { status });
    return Response.json({ statusCode: 0, data: [] });
  });
}
it("includes only verified dates after a date fails, and preserves the seat snapshot", async () => {
  const result = await fetchApiImaxSessions({ fetch: fetcher(), now, allowPartial: true });
  expect(result.dates).toEqual(["2026-09-18", "2026-09-20"]);
  expect(result.failedDates).toEqual(["2026-09-19"]);
  expect(await publishScheduleSnapshot("unused", result, now())).toMatchObject({ published: false });
});
it("never treats all failed dates or an unavailable calendar as an empty schedule", async () => {
  await expect(fetchApiImaxSessions({ fetch: fetcher(true), now, allowPartial: true })).rejects.toMatchObject({ status: 403 });
  await expect(fetchApiImaxSessions({ fetch: async () => new Response("denied", { status: 403 }), now, allowPartial: true })).rejects.toMatchObject({ status: 403 });
});
it("keeps default collection strict and carries rate-limit cooldown with successful dates", async () => {
  await expect(fetchApiImaxSessions({ fetch: fetcher(), now })).rejects.toMatchObject({ status: 403 });
  const partial = await fetchApiImaxSessions({ fetch: fetcher(false, 429), now, allowPartial: true });
  expect(partial.dates).toEqual(["2026-09-18", "2026-09-20"]);
  expect(partial.retryAt).toBe(now().getTime() + 300000);
});
it("successful dates return on recovery so failed dates are checked again", async () => {
  const result = await fetchApiImaxSessions({ now, allowPartial: true, fetch: async input => Response.json({ statusCode: 0,
    data: String(input).includes("searchSiteScnscYmdListBySite") ? dates.map(scnYmd => ({ scnYmd })) : [] }) });
  expect(result.dates).toHaveLength(3);
  expect(result.failedDates).toBeUndefined();
});
