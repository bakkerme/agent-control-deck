import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  outputDir: "test-results/playwright",
  testMatch: "**/*.spec.ts",
  testIgnore: ["**/titlebar.spec.ts", "**/native-lamps.spec.ts", "**/electron-smoke.spec.ts", "**/chat-matching.spec.ts"],
  timeout: 60000,
  workers: 1,
  reporter: "list",
  use: { headless: true, trace: "retain-on-failure" },
  webServer: {
    command: "node node_modules/vite/bin/vite.js preview --outDir out/renderer --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
