import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    remoteBindings: false,
    // The latest test pool embeds workerd with this maximum supported date.
    miniflare: { compatibilityDate: "2026-08-22", bindings: { SCHEDULE_ENABLED: "true", GITHUB_SCHEDULE_ENABLED: "false", GITHUB_TOKEN: "test-token", SEATS_ENABLED: "true", ENABLED: "true", AWS_REGION: "ap-northeast-2", AWS_ACCESS_KEY_ID: "test-only", AWS_SECRET_ACCESS_KEY: "test-only" } },
  })],
  test: { include: ["test/**/*.spec.ts"] },
});
