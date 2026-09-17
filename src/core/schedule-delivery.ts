import { validateSchedulePayload, type SchedulePayload } from "./schedule-payload";
export interface ScheduleState { version: 1; hash?: string; observedAt?: string; retryAt?: number }
export async function deliverChangedSchedule(payload: SchedulePayload, state: ScheduleState,
  invoke: (payload: SchedulePayload) => Promise<unknown>, save: (state: ScheduleState) => void, dryRun = false) {
  validateSchedulePayload(payload);
  if (payload.hash === state.hash) return { changed: false };
  const response = await invoke(payload) as { accepted?: boolean; hash?: string; dryRun?: boolean } | null;
  if (!response || response.accepted !== true || response.hash !== payload.hash || response.dryRun !== dryRun) {
    throw Error("Schedule Lambda did not acknowledge this hash; state unchanged");
  }
  if (!dryRun) save({ version: 1, hash: payload.hash, observedAt: payload.observedAt });
  return { changed: true, response };
}
