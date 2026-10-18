// Separate test build of the real desktop entry. Only SDK boundary is replaced.
const { build } = require('esbuild');
const { mkdirSync, cpSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve('out-tests/native-app');
mkdirSync(root, { recursive: true });
(async () => {
await build({ entryPoints: ['src/main/index.ts'], outfile: `${root}/main/index.cjs`, bundle: true,
  platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
  plugins: [{ name: 'test-sdk-boundary', setup(build) {
    build.onResolve({ filter: /embedded-sdk$/ }, args => args.importer.endsWith('native-live-sdk.ts') ? undefined
      : ({ path: resolve(process.argv.includes('--bounded-sdk') ? 'tests/native-live-sdk.ts' : 'tests/native-acceptance-sdk.ts') }));
  } }] });
for (const name of ['renderer', 'preload', 'local-matching']) cpSync(`out/${name}`, `${root}/${name}`, { recursive: true });
writeFileSync(`${root}/package.json`, JSON.stringify({ name: 'acd-native-acceptance', version: '0.0.0', main: 'main/index.cjs' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
