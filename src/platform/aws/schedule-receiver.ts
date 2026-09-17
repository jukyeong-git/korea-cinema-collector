import { readNotificationSwitch } from "./notification-switch";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createDynamoDbSessionRepository } from "./dynamodb-session-repository";
import { withSyncLease } from "./sync-lease";
import { validateSchedulePayload } from "../../core/schedule-payload";
import { findNewSessions, runSync } from "../../core/sync";
import { performanceStart } from "../../core/seat-monitor";
import { sendTelegramGroup } from "../../core/telegram";

const ssm = new SSMClient({});
export async function handler(event: unknown) {
  const now = new Date();
  const payload = validateSchedulePayload(event, now);
  const dryRun = (event as { dryRun?: unknown }).dryRun;
  if (dryRun !== undefined && typeof dryRun !== "boolean") throw Error("Invalid dryRun flag");
  const table = process.env.TABLE_NAME;
  if (!table) throw Error("TABLE_NAME is required");
  const repository = createDynamoDbSessionRepository(table);
  const schedule = { dates: payload.dates, sessions: payload.sessions.filter(s => performanceStart(s) > now.getTime()) };
  if (dryRun === true) {
    const known = await repository.listKnownPerformanceIds(schedule.sessions.map(s => s.performanceId));
    return { accepted: true, dryRun: true, hash: payload.hash,
      baselineRequired: !await repository.isInitialized(), newSessions: findNewSessions(schedule.sessions, known).length };
  }
  if (process.env.ALERTS_ENABLED !== "true") throw Error("Schedule receiver is disabled");
  // Share the legacy schedule lease: both receivers compare/store/deliver the same outbox.
  const result = await withSyncLease(table, async () => {
    const notificationsEnabled = await readNotificationSwitch();
    const outcome = await runSync({ repository, notificationsEnabled, fetchSessions: async () => schedule,
      sendNotification: async group => {
        if (!await readNotificationSwitch()) throw Error("Notifications switched off before delivery");
        const names = [process.env.TELEGRAM_BOT_TOKEN_PARAMETER!, process.env.TELEGRAM_CHAT_ID_PARAMETER!];
        const response = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
        const values = new Map(response.Parameters?.map(p => [p.Name, p.Value]));
        const token = values.get(names[0]), chat = values.get(names[1]);
        if (!token || !chat || response.InvalidParameters?.length) throw Error("Missing Telegram configuration");
        await sendTelegramGroup(token, chat, group);
      },
    }, now);
    // GitHub Actions publishes seat-candidate freshness even when this payload hash is unchanged.
    return { accepted: true, dryRun: false, hash: payload.hash, notificationsEnabled, ...outcome };
  }, undefined, "STATE#schedule_lease");
  if ("skipped" in result) throw Error("Schedule receiver busy; hash not acknowledged");
  return result;
}
