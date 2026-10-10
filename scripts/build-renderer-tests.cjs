const { buildSync } = require("esbuild");
buildSync({
  entryPoints: ["tests/renderer-backend.ts"],
  outfile: "out-tests/renderer-backend.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["better-sqlite3"],
});
