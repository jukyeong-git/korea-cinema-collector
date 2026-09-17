import { publishScheduleSnapshot } from "../src/platform/aws/schedule-snapshot";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { fetchApiImaxSessions } from "../src/collectors/cgv-api";
import { makeSchedulePayload } from "../src/core/schedule-payload";
import { deliverChangedSchedule, type ScheduleState } from "../src/core/schedule-delivery";

const path = process.env.STATE_PATH ?? "state/schedule.json";
const state: ScheduleState = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1 };
if (state.version !== 1 || (state.hash !== undefined && !/^[a-f0-9]{64}$/.test(state.hash))
  || (state.retryAt !== undefined && !Number.isFinite(state.retryAt))) throw Error("Invalid schedule state");
const dryRun = process.env.DRY_RUN === "true";
const save = (value: ScheduleState) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
if (state.retryAt && state.retryAt > Date.now()) {
  console.log("CGV schedule cooldown active until", new Date(state.retryAt).toISOString());
} else {
  try {
    // Existing complete-calendar collector, with at most five simultaneous requests.
    const schedule = await fetchApiImaxSessions();
    const observedAt = new Date();
    const payload = makeSchedulePayload(schedule, observedAt);
    if (!dryRun) {
      console.log(JSON.stringify({ event: "schedule_snapshot", ...await publishScheduleSnapshot(
        process.env.TABLE_NAME ?? "korea-cinema-alert", schedule, observedAt) }));
    }
    const result = await deliverChangedSchedule(payload, state, async value => {
      const response = await new LambdaClient({}).send(new InvokeCommand({
        FunctionName: process.env.LAMBDA_FUNCTION_NAME ?? "korea-cinema-alert-schedule-temp",
        InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify({ ...value, dryRun })),
      }));
      if (response.FunctionError || response.StatusCode !== 200 || !response.Payload) {
        throw Error("Schedule Lambda failed; hash not acknowledged");
      }
      return JSON.parse(Buffer.from(response.Payload).toString());
    }, save, dryRun);
    console.log(JSON.stringify({ dates: payload.dates.length, sessions: payload.sessions.length, hash: payload.hash, dryRun, ...result }));
  } catch (error) {
    if (!dryRun && error && typeof error === "object" && "retryAt" in error
      && typeof error.retryAt === "number" && Number.isFinite(error.retryAt)) save({ ...state, retryAt: error.retryAt });
    throw error;
  }
}
