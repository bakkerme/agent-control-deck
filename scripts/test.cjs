const { buildSync } = require("esbuild");
const { readdirSync, mkdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join, basename } = require("node:path");
mkdirSync("out-tests", { recursive: true });
const entries = readdirSync("tests")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join("tests", f));
buildSync({
  entryPoints: entries,
  outdir: "out-tests",
  bundle: true,
  platform: "node",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  external: ["better-sqlite3", "@anthropic-ai/claude-agent-sdk"],
});
const result = spawnSync(
  require("electron"),
  [
    "--test",
    ...entries.map((f) =>
      join("out-tests", `${basename(f, ".ts")}.cjs`),
    ),
  ],
  { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
);
process.exit(result.status ?? 1);
