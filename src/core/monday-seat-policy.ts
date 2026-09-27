import type { SeatCandidate, SeatSnapshot } from "./types";

export const SEAT_DELAY_MS = 60 * 60_000;
// A changed seat range needs a fresh, silent baseline before release alerts resume.
export const SEAT_POLICY = "preferred-F-L-16-29-v2-after1h";

export { performanceStart } from "./seat-monitor";
