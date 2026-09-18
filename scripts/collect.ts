import { readFileSync, writeFileSync } from "node:fs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { fetchPreferredSeats } from "../src/collectors/cgv-seats";
import { createDynamoDbSessionRepository } from "../src/platform/aws/dynamodb-session-repository";
import { makePayload, readyCandidates, type SeatEntry } from "../src/core/seat-payload";

const statePath = process.env.STATE_PATH ?? "state/seats.json";
const state = JSON.parse(readFileSync(statePath, "utf8")) as { version: number; hash?: string; observedAt?: string; retryAt?: number };
if (state.version !== 1 || (state.hash !== undefined && !/^[a-f0-9]{64}$/.test(state.hash))) throw Error("Invalid state file");
const now = new Date();
if (state.retryAt && state.retryAt > now.getTime()) {
  console.log("CGV cooldown active until", new Date(state.retryAt).toISOString());
} else {
  try {
    const repository = createDynamoDbSessionRepository(process.env.TABLE_NAME ?? "korea-cinema-alert");
    const candidates = await repository.readSeatCandidates();
    if (!candidates) throw Error("Missing or stale schedule snapshot; state unchanged");
    const context = await repository.loadSeatContext(candidates.map(c => c.performanceId));
    const ready = readyCandidates(candidates, context.firstSeen, now);
    const entries: SeatEntry[] = [];
    let next = 0, stopped = false;
    const failures: { performanceId: string; retryAt?: number }[] = [];
    const deadline = AbortSignal.timeout(120_000);
    // Preserve the existing maximum of five concurrent CGV requests.
    const results = await Promise.allSettled(Array.from({ length: Math.min(5, ready.length) }, async () => {
      while (!stopped && next < ready.length) {
        const candidate = ready[next++];
        try { entries.push({ performanceId: candidate.performanceId, ...await fetchPreferredSeats(candidate, deadline) }); }
        catch (error) {
          const detail = error as { status?: number; retryAt?: number };
          failures.push({ performanceId: candidate.performanceId, retryAt: detail?.retryAt });
          console.warn(JSON.stringify({ event: "seat_collection_failed", performanceId: candidate.performanceId,
            date: candidate.displayDate, status: detail?.status }));
          if (detail?.status === 429 || deadline.aborted) stopped = true;
        }
      }
    }));
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (errors.length) throw errors[0].reason;
    const retryAt = Math.max(0, ...failures.map(f => Number(f.retryAt) || 0));
    if (ready.length && !entries.length) throw Object.assign(Error("All seat queries failed; state unchanged"), retryAt ? { retryAt } : {});
    const payload = { ...makePayload(entries, now), ...(entries.length < ready.length ? { partial: true } : {}) };
    console.log(JSON.stringify({ checked: entries.length, failed: failures.length, skipped: ready.length - entries.length - failures.length, partial: payload.partial === true, hash: payload.hash, changed: state.hash !== payload.hash }));
    if (process.env.DRY_RUN === "true") {
      console.log("Dry run: collection validated; Lambda and state unchanged");
    } else if (payload.hash !== state.hash) {
      const result = await new LambdaClient({}).send(new InvokeCommand({
        FunctionName: process.env.LAMBDA_FUNCTION_NAME ?? "korea-cinema-alert-seats",
        InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(payload)),
      }));
      if (result.FunctionError || result.StatusCode !== 200 || !result.Payload) throw Error("Lambda invocation failed; hash not acknowledged");
      const response = JSON.parse(Buffer.from(result.Payload).toString());
      if (response.accepted !== true || response.hash !== payload.hash) throw Error("Lambda did not acknowledge this hash");
      writeFileSync(statePath, JSON.stringify({ version: 1, hash: payload.hash, observedAt: payload.observedAt }, null, 2) + "\n");
      console.log("Lambda acknowledged", JSON.stringify(response));
    }
    if (retryAt && process.env.DRY_RUN !== "true") {
      const acknowledged = JSON.parse(readFileSync(statePath, "utf8"));
      writeFileSync(statePath, JSON.stringify({ ...acknowledged, retryAt }, null, 2) + "\n");
    }
  } catch (error) {
    if (process.env.DRY_RUN !== "true" && error && typeof error === "object" && "retryAt" in error && typeof error.retryAt === "number") {
      writeFileSync(statePath, JSON.stringify({ ...state, retryAt: error.retryAt }, null, 2) + "\n");
    }
    throw error;
  }
}
