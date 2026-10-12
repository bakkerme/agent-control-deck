import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(process.argv[2] ?? "test-results/local-decision-test.mjs");
const [worker, downloader, license] = await Promise.all([
  readFile(resolve(here, "local_worker.py"), "utf8"), readFile(resolve(here, "bundle_download.py"), "utf8"),
  readFile(resolve(here, "../../node_modules/zod/LICENSE"), "utf8"),
]);
await mkdir(dirname(outfile), { recursive: true });
await build({ entryPoints: [resolve(here, "benchmark.mjs")], outfile, bundle: true, platform: "node", target: "node24", format: "esm",
  define: { __WORKER_SOURCE__: JSON.stringify(worker), __DOWNLOADER_SOURCE__: JSON.stringify(downloader) },
  banner: { js: `#!/usr/bin/env node\n/* Standalone local decision-model evaluation. Node 24+.\n * Embedded Zod license:\n${license.replaceAll("*/", "* /")}\n */` },
  legalComments: "inline" });
console.log(`Portable bundle: ${outfile}\nCopy this single file and run: node local-decision-test.mjs`);
