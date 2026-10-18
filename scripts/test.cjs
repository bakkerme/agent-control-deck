const { buildSync } = require("esbuild");
const { readdirSync, mkdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join, basename } = require("node:path");
mkdirSync("out-tests", { recursive: true });
const entries = readdirSync("tests")
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => !process.argv[2] || process.argv.slice(2).includes(basename(f, ".test.ts")))
  .map((f) => join("tests", f));
if (!entries.length) throw new Error("No matching backend tests");
buildSync({
  entryPoints: [...entries, "tests/embedded-crash-worker.ts"],
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
