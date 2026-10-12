const { join, resolve, dirname } = require("node:path");
const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const binary =
  process.platform === "darwin"
    ? join(
        "release",
        process.arch === "arm64" ? "mac-arm64" : "mac",
        "Agent Control Deck.app",
        "Contents",
        "MacOS",
        "Agent Control Deck",
      )
    : process.platform === "win32"
      ? join(
          "release",
          process.arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked",
          "Agent Control Deck.exe",
        )
      : join("release", "linux-unpacked", "agent-control-deck");
if (!existsSync(binary)) {
  console.error("Build the app first with npm run package");
  process.exit(1);
}
const resources = process.platform === "darwin" ? join(dirname(binary), "../Resources") : join(dirname(binary), "resources");
for (const file of ["setup.cjs", "desktop_worker.py", "local_worker.py", "bundle_download.py"]) {
  if (!existsSync(join(resources,"local-matching",file))) {
    console.error(`Missing packaged local matching resource: ${file}`);
    process.exit(1);
  }
}
const result = spawnSync(
  process.execPath,
  [require.resolve("@playwright/test/cli"), "test", "--config", "playwright.electron.config.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, ACD_PACKAGED_EXECUTABLE: resolve(binary) },
  },
);
process.exit(result.status ?? 1);
