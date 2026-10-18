if (process.platform !== "linux") throw new Error("SDK process acceptance requires Linux /proc; no cross-platform claim");
const { buildSync } = require('esbuild');
const { spawnSync } = require('node:child_process');
buildSync({ entryPoints: ['tests/sdk-process.acceptance.ts', 'tests/sdk-process-worker.ts'], outdir: 'out-tests', bundle: true,
  platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'] });
const result = spawnSync(require('electron'), ['--test', 'out-tests/sdk-process.acceptance.cjs'], { stdio: 'inherit', env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1' } });
process.exit(result.status ?? 1);
