import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// Longer than the 120-second Lambda timeout: an expired owner cannot still run.
export async function withSyncLease<T>(tableName: string, work: () => Promise<T>, db = client, leaseKey = "STATE#sync_lease") {
  const owner = randomUUID();
  const now = Date.now();
  try {
    await db.send(new UpdateCommand({
      TableName: tableName, Key: { pk: leaseKey },
      UpdateExpression: "SET leaseOwner = :owner, expiresAt = :expires",
      ConditionExpression: "attribute_not_exists(expiresAt) OR expiresAt < :now",
      ExpressionAttributeValues: { ":owner": owner, ":expires": now + 300_000, ":now": now },
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      console.log("CGV sync skipped: active lease or rate-limit cooldown", { leaseKey });
      return { skipped: true };
    }
    throw error;
  }
  let releaseAt = 0;
  try { return await work(); }
  catch (error) {
    // Persist a CGV Retry-After cooldown across warm/cold invocations using the
    // same conditional lease. Do not retry a rate-limited request immediately.
    if (error && typeof error === "object" && "retryAt" in error && typeof error.retryAt === "number" && Number.isFinite(error.retryAt)) {
      releaseAt = Math.max(Date.now() + 60_000, error.retryAt);
    }
    throw error;
  }
  finally {
    await db.send(new UpdateCommand({
      TableName: tableName, Key: { pk: leaseKey },
      UpdateExpression: "SET expiresAt = :expired",
      ConditionExpression: "leaseOwner = :owner",
      ExpressionAttributeValues: { ":owner": owner, ":expired": releaseAt },
    }));
  }
}
