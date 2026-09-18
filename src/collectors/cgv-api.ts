import type { PublishedSchedule, SeatCandidate } from "../core/types";
import { koreaDate, parseRows, scheduleDate } from "./cgv-model";

export const CGV_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const origin = "https://cgv.co.kr";
type Row = Record<string, unknown>;
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Malformed CGV row");
  return value as Row;
}
function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) throw Error(`Missing CGV field: ${key}`);
  return value.trim();
}

// Matches the public movieBook/cinema UI observed on 2026-09-10:
// title2 uses movNm except bundled/double-feature products; disabled buttons
// include controlled, started and sold-out performances.
export function parseApiSchedule(values: unknown[], date: string, now = new Date()) {
  const seatCandidates: SeatCandidate[] = [];
  const movieNumbers = new Map<string, string>();
  const dayTimes: number[] = [];
  const rows = values.map(value => {
    const row = object(value);
    if (!["0013", "P013"].includes(text(row, "siteNo")) || scheduleDate(text(row, "scnYmd")) !== date) {
      throw Error("CGV API returned an unexpected theater or date");
    }
    return row;
  });
  const sessions = parseRows(rows.filter(row => row.siteNo === "0013" && /IMAX|아이맥스/i.test(text(row, "scnsNm"))).map(row => {
    const title = text(row, row.cxprdYn === "Y" || row.dblfrRpsntYn === "Y" ? "expoProdNm" : "movNm");
    const movieNo = text(row, "movNo");
    if (!/^\d+$/.test(movieNo)) throw Error("Invalid CGV movie number");
    const screen = text(row, "expoScnsNm");
    const format = text(row, "movkndDsplEnm") + (row.sbtdivNm ? ` / ${text(row, "sbtdivNm")}` : "");
    const time = text(row, "scnsrtTm");
    if (!/^(?:[0-3]\d|4[0-7])[0-5]\d$/.test(time)) throw Error("Invalid CGV start time");
    dayTimes.push(Number(time));
    if (row.cntlYn !== "Y" && row.cntlYn !== "N") throw Error("Unknown CGV booking control flag");
    const seats = text(row, "frSeatCnt");
    if (!/^\d+$/.test(seats) || !Number.isSafeInteger(Number(seats))) throw Error("Invalid CGV remaining seats");
    const startsAt = Date.parse(`${date}T00:00:00+09:00`) + (Number(time.slice(0, 2)) * 60 + Number(time.slice(2))) * 60_000;
    const disabled = row.cntlYn === "Y" || startsAt <= now.getTime() || Number(seats) === 0;
    const display = { title, screen, format, time: `${time.slice(0, 2)}:${time.slice(2)}`, status: row.cntlYn === "Y" ? "예매 준비중" : "예매 가능", disabled };
    if (row.cntlYn === "N" && startsAt > now.getTime()) {
      const seatQuery = { coCd: text(row, "coCd"), siteNo: text(row, "siteNo"), scnYmd: text(row, "scnYmd"), scnsNo: text(row, "scnsNo"), scnSseq: text(row, "scnSseq") };
      if (seatQuery.coCd !== "A420" || seatQuery.scnsNo !== "018" || !/^\d+$/.test(seatQuery.scnSseq)) throw Error("Unexpected Yongsan IMAX seat identifiers");
      // Keep sold-out performances for seat monitoring, without changing the
      // established bookable-only new-schedule IDs or notification behavior.
      const session = parseRows([{ ...display, disabled: false }], date)[0];
      movieNumbers.set(session.performanceId, movieNo);
      seatCandidates.push({ ...session, movieNo, seatQuery });
    }
    return display;
  }), date);
  if (new Set(seatCandidates.map(s => s.performanceId)).size !== seatCandidates.length) throw Error("Duplicate CGV IMAX performance");
  const first = Math.min(...dayTimes), last = Math.max(...dayTimes);
  return { sessions: sessions.map(session => ({ ...session, movieNo: movieNumbers.get(session.performanceId)! })),
    seatCandidates: seatCandidates.map(candidate => ({ ...candidate,
      isDayBoundary: [first, last].includes(Number(candidate.displayTime.replace(":", ""))),
    })) };
}

export function parseApiRows(values: unknown[], date: string, now = new Date()) {
  return parseApiSchedule(values, date, now).sessions;
}

export class CgvHttpError extends Error {
  readonly retryAt?: number;
  constructor(readonly status: number, readonly retryAfter: string | null, readonly errorBody: string, now = Date.now()) {
    super(`CGV API HTTP ${status}; Retry-After=${retryAfter ?? "absent"}; body=${errorBody}`);
    if (status === 429) {
      const requested = retryAfter && /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter ?? "");
      this.retryAt = Number.isFinite(requested) ? Math.max(now + 60_000, requested) : now + 300_000;
    }
  }
}

export async function fetchApiImaxSessions(options: { fetch?: typeof fetch; now?: () => Date; allowPartial?: boolean } = {}): Promise<PublishedSchedule> {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const today = koreaDate(now());
  const deadline = AbortSignal.timeout(100_000);
  async function request(endpoint: string, day?: string): Promise<unknown[]> {
    const params = new URLSearchParams({ coCd: "A420", siteNo: "0013" });
    if (day) { params.set("scnYmd", day); params.set("rtctlScopCd", "08"); }
    const response = await fetcher(`${origin}/api/v1/booking/${endpoint}?${params}`, {
      headers: { "user-agent": CGV_USER_AGENT, accept: "application/json", referer: `${origin}/cnm/movieBook/cinema` },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
    });
    const body = await response.text();
    if (!response.ok) throw new CgvHttpError(response.status, response.headers.get("retry-after"),
      body.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]").slice(0, 4096), now().getTime());
    const payload = object(JSON.parse(body));
    if (payload.statusCode !== 0 || !Array.isArray(payload.data)) throw Error("CGV API response unsuccessful or malformed");
    return payload.data;
  }
  const calendar = await request("searchSiteScnscYmdListBySite");
  const dates = [...new Set(calendar.map(value => scheduleDate(text(object(value), "scnYmd"))))];
  if (!dates.length || dates.length > 62) throw Error("Invalid or empty CGV calendar");
  const batches = new Array<ReturnType<typeof parseApiSchedule>>(dates.length);
  let nextIndex = 0;
  let failed = false;
  const failures: { date: string; error: unknown }[] = [];
  async function worker() {
    while (!failed && nextIndex < dates.length) {
      const index = nextIndex++;
      const date = dates[index];
      try {
        batches[index] = parseApiSchedule(await request("searchMovScnInfo", date.replaceAll("-", "")), date, now());
        console.log(JSON.stringify({ event: "schedule_date_collected", date, sessions: batches[index].sessions.length }));
      } catch (error) {
        failures.push({ date, error });
        console.warn(JSON.stringify({ event: "schedule_date_failed", date,
          status: error instanceof CgvHttpError ? error.status : undefined,
          error: error instanceof CgvHttpError ? "CGV HTTP error" : "Request or validation failed" }));
        if (!options.allowPartial || (error instanceof CgvHttpError && error.status === 429)) {
          failed = true;
          throw error;
        }
      }
    }
  }
  // Drain in-flight requests before returning an error; don't start more dates
  // after failure or publish a partial schedule. Preserve calendar order.
  const results = await Promise.allSettled(Array.from({ length: Math.min(5, dates.length) }, worker));
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  const successfulDates = dates.filter((_, index) => batches[index] !== undefined);
  const limited = failures.map(f => f.error).filter((e): e is CgvHttpError => e instanceof CgvHttpError && e.status === 429);
  limited.sort((a, b) => (b.retryAt ?? 0) - (a.retryAt ?? 0));
  if ((!options.allowPartial && errors.length) || !successfulDates.length) {
    throw limited[0] ?? failures[0]?.error ?? Error("No successfully collected dates");
  }
  const sessions = batches.flatMap(batch => batch?.sessions ?? []);
  const seatCandidates = batches.flatMap(batch => batch?.seatCandidates ?? []);
  if (koreaDate(now()) !== today) throw Error("CGV collection crossed midnight; refusing partial schedule");
  return { dates: successfulDates, sessions, seatCandidates,
    ...(successfulDates.length < dates.length ? { failedDates: dates.filter(date => !successfulDates.includes(date)) } : {}),
    ...(limited[0]?.retryAt ? { retryAt: limited[0].retryAt } : {}),
  };
}
