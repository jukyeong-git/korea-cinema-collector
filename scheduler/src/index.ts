import { DurableObject } from "cloudflare:workers";

type Slot = { id: string; due: number; expires: number; status: string };

export async function dispatchWorkflow(env: Env, slot: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!env.GITHUB_TOKEN) throw Error("Missing GitHub dispatch credential");
  const response = await fetcher(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json", "content-type": "application/json",
      "user-agent": "koprea-cinema-scheduler", "x-github-api-version": "2026-03-10",
    },
    body: JSON.stringify({ ref: env.GITHUB_REF, inputs: { dry_run: env.DRY_RUN } }),
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (response.status !== 200 && response.status !== 204) throw Error(`GitHub dispatch failed: HTTP ${response.status}`);
  console.log(JSON.stringify({ event: "github_dispatched", slot, workflow: env.GITHUB_WORKFLOW, dryRun: env.DRY_RUN === "true" }));
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
    // Synchronous claims deduplicate repeated cron events before external I/O.
    const inserted = this.ctx.storage.sql.exec<{ id: string }>(
      "INSERT OR IGNORE INTO slots VALUES (?, ?, ?, 'pending') RETURNING id", `${cycle}:cron`, now, now + 60_000,
    ).toArray();
    if (!inserted.length) return;
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO slots VALUES (?, ?, ?, 'pending')", `${cycle}:alarm`, now + 30_000, now + 60_000);
    await this.armNextAlarm();
    const pending = [this.sendSlot(`${cycle}:cron`)];
    if (this.env.SCHEDULE_ENABLED === "true") {
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO slots VALUES (?, ?, ?, 'pending')", `${cycle}:schedule`, now, now + 60_000);
      pending.push(this.sendSlot(`${cycle}:schedule`));
    }
    await Promise.all(pending);
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
    if (Date.now() > slot.expires || this.env.ENABLED !== "true") {
      this.ctx.storage.sql.exec("UPDATE slots SET status = 'skipped' WHERE id = ?", id); return;
    }
    try {
      await dispatchWorkflow(id.endsWith(":schedule")
        ? { ...this.env, GITHUB_WORKFLOW: this.env.GITHUB_SCHEDULE_WORKFLOW } : this.env, id);
      this.ctx.storage.sql.exec("UPDATE slots SET status = 'sent' WHERE id = ?", id);
    } catch (error) {
      // GitHub dispatch has no idempotency key. Do not replay ambiguous requests;
      // the next scheduled slot provides a fresh attempt without duplicate runs.
      this.ctx.storage.sql.exec("UPDATE slots SET status = 'failed' WHERE id = ?", id);
      console.error(JSON.stringify({ event: "github_dispatch_failed", slot: id, error: error instanceof Error ? error.message : "Unknown dispatch error" }));
    }
  }
  async alarm(): Promise<void> {
    const due = this.ctx.storage.sql.exec<Slot>(
      "SELECT * FROM slots WHERE status = 'pending' AND id LIKE '%:alarm' AND due <= ? ORDER BY due", Date.now(),
    ).toArray();
    try { for (const slot of due) await this.sendSlot(slot.id); }
    finally { await this.armNextAlarm(); }
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (env.ENABLED !== "true") return;
    await env.SCHEDULER.getByName(`${env.GITHUB_REPOSITORY}/${env.GITHUB_WORKFLOW}`).tick(controller.scheduledTime);
  },
  fetch(): Response { return new Response("Not found", { status: 404 }); },
} satisfies ExportedHandler<Env>;
