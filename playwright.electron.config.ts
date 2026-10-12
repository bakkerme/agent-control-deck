import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  outputDir: "test-results/electron",
  testMatch: ["**/electron-smoke.spec.ts", "**/native-lamps.spec.ts", "**/titlebar.spec.ts", "**/chat-matching.spec.ts"],
  timeout: 60000,
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
