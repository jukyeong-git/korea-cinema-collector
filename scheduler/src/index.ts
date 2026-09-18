import { DurableObject } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";

type Slot = { id: string; due: number; expires: number; status: string };
export const targets = ["schedule", "seats-01", "seats-02", "seats-03", "seats-04"] as const;
export type Target = typeof targets[number];

export function enabled(env: Env, target: Target): boolean {
  return env.ENABLED === "true" && (target === "schedule" ? env.SCHEDULE_ENABLED : env.SEATS_ENABLED) === "true";
}

export async function invokeLambda(env: Env, target: Target, slot: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw Error("Missing AWS invoke credential");
  const client = new AwsClient({ accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    service: "lambda", region: env.AWS_REGION });
  const request = await client.sign(`https://lambda.${env.AWS_REGION}.amazonaws.com/2015-03-31/functions/korea-cinema-alert-${target}/invocations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-amz-invocation-type": "Event" },
    body: JSON.stringify({ source: "cloudflare-scheduler", slot }),
  });
  // Sign only: no SDK retries after an ambiguous response. The next slot retries collection.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(request, { signal: controller.signal });
    await response.body?.cancel();
    if (response.status !== 202) throw Error(`Lambda invoke failed: HTTP ${response.status}`);
    console.log(JSON.stringify({ event: "lambda_accepted", target, slot }));
  } finally {
    // Release the timeout immediately so successful calls do not keep the DO awake.
    clearTimeout(timer);
  }
}

export class CinemaScheduler extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS slots (id TEXT PRIMARY KEY, due INTEGER NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL)");
  }
  async tick(scheduledTime: number): Promise<void> {
    if (this.env.ENABLED !== "true") return;
    const now = Date.now();
    if (!Number.isFinite(scheduledTime) || scheduledTime > now + 10_000 || now - scheduledTime > 60_000) {
      console.log(JSON.stringify({ event: "stale_cron_skipped" })); return;
    }
    const cycle = String(Math.floor(scheduledTime / 60_000));
    this.ctx.storage.sql.exec("DELETE FROM slots WHERE expires < ?", now - 120_000);
    // A synchronous cycle claim prevents duplicate cron delivery across awaits/restarts.
    const inserted = this.ctx.storage.sql.exec<{ id: string }>(
      "INSERT OR IGNORE INTO slots VALUES (?, ?, ?, 'cycle') RETURNING id", `${cycle}:cycle`, now, now + 60_000,
    ).toArray();
    if (!inserted.length) return;
    const immediate: string[] = [];
    for (const target of targets.filter(target => enabled(this.env, target))) {
      for (const phase of ["cron", "alarm"] as const) {
        const id = `${cycle}:${target}:${phase}`;
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO slots VALUES (?, ?, ?, 'pending')", id, now + (phase === "alarm" ? 30_000 : 0), now + 60_000);
        if (phase === "cron") immediate.push(id);
      }
    }
    // Persist the alarm before any network call, so immediate failure cannot cancel it.
    await this.armNextAlarm();
    await Promise.all(immediate.map(id => this.sendSlot(id)));
  }
  private async armNextAlarm(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ due: number }>(
      "SELECT due FROM slots WHERE status = 'pending' AND id LIKE '%:alarm' ORDER BY due LIMIT 1",
    ).toArray()[0];
    if (next) await this.ctx.storage.setAlarm(next.due);
  }
  private async sendSlot(id: string): Promise<void> {
    const slot = this.ctx.storage.sql.exec<Slot>(
      "UPDATE slots SET status = 'claimed' WHERE id = ? AND status = 'pending' RETURNING *", id,
    ).toArray()[0];
    if (!slot) return;
    const target = targets.find(target => id.split(":")[1] === target);
    if (!target || Date.now() > slot.expires || !enabled(this.env, target)) {
      this.ctx.storage.sql.exec("UPDATE slots SET status = 'skipped' WHERE id = ?", id); return;
    }
    try {
      await invokeLambda(this.env, target, id);
      this.ctx.storage.sql.exec("UPDATE slots SET status = 'sent' WHERE id = ?", id);
    } catch (error) {
      this.ctx.storage.sql.exec("UPDATE slots SET status = 'failed' WHERE id = ?", id);
      // Never log request objects or credentials from signing/network errors.
      console.error(JSON.stringify({ event: "lambda_dispatch_failed", target, slot: id,
        reason: error instanceof Error && /^Lambda invoke failed: HTTP \d+$/.test(error.message) ? error.message : "Invoke network or credential error" }));
    }
  }
  async alarm(): Promise<void> {
    const due = this.ctx.storage.sql.exec<Slot>(
      "SELECT * FROM slots WHERE status = 'pending' AND id LIKE '%:alarm' AND due <= ? ORDER BY due", Date.now(),
    ).toArray();
    try { await Promise.all(due.map(slot => this.sendSlot(slot.id))); }
    finally { await this.armNextAlarm(); }
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (env.ENABLED !== "true") return;
    await env.SCHEDULER.getByName("korea-cinema-alert/aws-v1").tick(controller.scheduledTime);
  },
  fetch(): Response { return new Response("Not found", { status: 404 }); },
} satisfies ExportedHandler<Env>;
