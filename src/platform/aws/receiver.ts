import { readNotificationSwitch } from "./notification-switch";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createDynamoDbSessionRepository } from "./dynamodb-session-repository";
import { withSyncLease } from "./sync-lease";
import { observePreferredSeats } from "../../core/seat-monitor";
import { runSeatsSync } from "../../core/seats-sync";
import { sendTelegramGroup } from "../../core/telegram";
import { ALL_DAYS, readyCandidates, validateAgainstCandidates, validatePayload } from "../../core/seat-payload";

const ssm = new SSMClient({});
export async function handler(event: unknown) {
  const now = new Date();
  const payload = validatePayload(event, now);
  const table = process.env.TABLE_NAME;
  if (!table) throw Error("TABLE_NAME is required");
  const repository = createDynamoDbSessionRepository(table);
  const result = await withSyncLease(table, async () => {
    const candidates = await repository.readSeatCandidates();
    if (!candidates) throw Error("Missing or stale DynamoDB schedule snapshot");
    const context = await repository.loadSeatContext(candidates.map(c => c.performanceId));
    // Eligibility is evaluated at collection time, then expired shows are excluded by the observer.
    const ready = readyCandidates(candidates, context.firstSeen, new Date(payload.observedAt));
    validateAgainstCandidates(payload, ready);
    for (const entry of payload.entries) {
      const previous = context.observations.get(entry.performanceId);
      if (previous && Date.parse(previous.observedAt) > Date.parse(payload.observedAt)) throw Error("Out-of-order observation");
    }
    if (process.env.ALERTS_ENABLED !== "true") throw Error("Seat receiver is disabled");
    const snapshots = new Map(payload.entries.map(e => [e.performanceId, e]));
    const currentAvailableSeats = new Map<string, string[]>();
    const notificationsEnabled = await readNotificationSwitch();
    const outcome = await runSeatsSync({ repository, currentAvailableSeats, notificationsEnabled,
      observeSeats: async (items, notify) => { await observePreferredSeats(items, {
        loadSeatContext: async () => context,
        storeSeatObservation: async (...args) => {
          // Persist the source observation time, not the Lambda processing time.
          const stored = await repository.storeSeatObservation(args[0], args[1], args[2], payload.observedAt, args[4]);
          if (!stored) throw Error("Concurrent seat update; retry collection");
          return true;
        },
      }, async c => {
        const snapshot = snapshots.get(c.performanceId);
        if (!snapshot) throw Error("Missing collected snapshot");
        currentAvailableSeats.set(c.performanceId, snapshot.available);
        return snapshot;
      }, notify, now, ALL_DAYS); },
      sendNotification: async group => {
        if (!await readNotificationSwitch()) throw Error("Notifications switched off before delivery");
        const names = [process.env.TELEGRAM_BOT_TOKEN_PARAMETER!, process.env.TELEGRAM_CHAT_ID_PARAMETER!];
        const response = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
        const values = new Map(response.Parameters?.map(p => [p.Name, p.Value]));
        const token = values.get(names[0]), chat = values.get(names[1]);
        if (!token || !chat || response.InvalidParameters?.length) throw Error("Missing Telegram configuration");
        await sendTelegramGroup(token, chat, group);
      },
    }, ready.filter(c => snapshots.has(c.performanceId)), now, ALL_DAYS);
    return { accepted: true, hash: payload.hash, notificationsEnabled, ...outcome };
  }, undefined, "STATE#github_seats_lease");
  if ("skipped" in result) throw Error("Seat receiver busy; retry collection");
  return result;
}
