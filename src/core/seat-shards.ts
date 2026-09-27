export const SEAT_SHARDS = {
  "01": {weekday: 1, name: "Monday"}, "02": {weekday: 2, name: "Tuesday"},
  "03": {weekday: 3, name: "Wednesday"}, "04": {weekday: 4, name: "Thursday"},
  "05": {weekday: 5, name: "Friday"}, "06": {weekday: 6, name: "Saturday"},
  "07": {weekday: 0, name: "Sunday"},
} as const;
export type SeatShard = keyof typeof SEAT_SHARDS;
export function seatShard(value = "01") {
  if (!Object.hasOwn(SEAT_SHARDS, value)) throw Error("Invalid SEAT_SHARD");
  const id = value as SeatShard;
  return {id, ...SEAT_SHARDS[id]};
}
