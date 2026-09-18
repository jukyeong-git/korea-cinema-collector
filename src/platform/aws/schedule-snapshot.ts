import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { PublishedSchedule } from "../../core/types";
import { makeSchedulePayload, validateSchedulePayload } from "../../core/schedule-payload";
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function publishScheduleSnapshot(tableName: string, schedule: PublishedSchedule, now = new Date(), db = client) {
  if (schedule.failedDates?.length) return { published: false, reason: "partial schedule; previous snapshot preserved" };
  const candidates = schedule.seatCandidates;
  if (!Array.isArray(candidates)) throw Error("Missing complete seat candidates");
  // Validate sold-out as well as bookable performances before replacing the full snapshot.
  validateSchedulePayload(makeSchedulePayload({ dates: schedule.dates, sessions: candidates }, now), now);
  for (const candidate of candidates) {
    const q = candidate.seatQuery;
    if (typeof candidate.isDayBoundary !== "boolean" || !q || q.coCd !== "A420" || q.siteNo !== "0013"
      || q.scnsNo !== "018" || q.scnYmd !== candidate.displayDate.replaceAll("-", "")
      || !/^\d+$/.test(q.scnSseq)) throw Error("Invalid seat candidate query");
  }
  const observedAt = now.toISOString();
  const Item = { pk: "STATE#seat_candidates", candidates, observedAt, source: "github-actions" };
  if (Buffer.byteLength(JSON.stringify(Item)) > 350000) throw Error("Seat snapshot too large");
  try {
    await db.send(new PutCommand({ TableName: tableName, Item,
      ConditionExpression: "attribute_not_exists(observedAt) OR observedAt <= :observedAt",
      ExpressionAttributeValues: { ":observedAt": observedAt },
    }));
    return { published: true, observedAt, candidates: candidates.length };
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      return { published: false, reason: "newer snapshot already stored" };
    }
    throw error;
  }
}
