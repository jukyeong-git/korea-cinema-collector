import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    remoteBindings: false,
    // The latest test pool embeds workerd with this maximum supported date.
    miniflare: { compatibilityDate: "2026-08-22", bindings: { GITHUB_REF: "main", GITHUB_REPOSITORY: "jukyeong-git/korea-cinema-collector", GITHUB_WORKFLOW: "seats.yml", ENABLED: "true", DRY_RUN: "true", GITHUB_TOKEN: "test-only" } },
  })],
  test: { include: ["test/**/*.spec.ts"] },
});
