// Separate test build of the real desktop entry. Only SDK boundary is replaced.
const { build } = require('esbuild');
const { mkdirSync, cpSync, writeFileSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require("node:crypto");
const root = resolve('out-tests/native-app');
mkdirSync(root, { recursive: true });
(async () => {
await build({ entryPoints: ['src/main/index.ts'], outfile: `${root}/main/index.cjs`, bundle: true,
  platform: 'node', format: 'cjs', define: { __SDK_SUPERVISOR_SOURCE_HASH__: JSON.stringify(createHash('sha256').update(readFileSync('src/main/sdk-supervisor.c')).digest('hex')) }, external: ['electron', 'better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
  plugins: [{ name: 'test-sdk-boundary', setup(build) {
    build.onResolve({ filter: /embedded-sdk$/ }, args => args.importer.endsWith('native-live-sdk.ts') ? undefined
      : ({ path: resolve(process.argv.includes('--bounded-sdk') ? 'tests/native-live-sdk.ts' : 'tests/native-acceptance-sdk.ts') }));
  } }] });
if (process.platform === "linux") for (const name of ["sdk-supervisor", "sdk-supervisor.json"]) cpSync(`out/${name}`, `${root}/${name}`);
for (const name of ['renderer', 'preload', 'local-matching']) cpSync(`out/${name}`, `${root}/${name}`, { recursive: true });
writeFileSync(`${root}/package.json`, JSON.stringify({ name: 'acd-native-acceptance', version: '0.0.0', main: 'main/index.cjs' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
