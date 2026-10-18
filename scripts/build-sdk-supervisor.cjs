// Linux packaging includes this tiny native process owner. Other OSes retain
// their existing SDK spawn path; no cross-platform containment claim is made.
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
if (process.platform === 'linux') {
  mkdirSync('out', { recursive: true });
  const result = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', 'src/main/sdk-supervisor.c', '-o', 'out/sdk-supervisor'], { stdio: 'inherit' });
  if (process.argv.includes('--test')) {
    mkdirSync('out-tests', { recursive: true });
    const test = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-DACD_SUPERVISOR_TEST', 'src/main/sdk-supervisor.c', '-o', 'out-tests/sdk-supervisor-test'], { stdio: 'inherit' });
    if (test.error || test.status !== 0) throw new Error('Linux supervisor test build failed');
    const owner = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-DACD_SUPERVISOR_PRE_OWNER_TEST', 'src/main/sdk-supervisor.c', '-o', 'out-tests/sdk-supervisor-owner-test'], { stdio: 'inherit' });
    if (owner.error || owner.status !== 0) throw new Error('Linux supervisor owner-race test build failed');
  }
  if (result.error || result.status !== 0) throw new Error('Linux SDK supervisor build failed; install a C compiler before building');
  writeFileSync('out/sdk-supervisor.json', JSON.stringify({ protocol: 1, appVersion: require('../package.json').version, sourceSha256: createHash('sha256').update(readFileSync('src/main/sdk-supervisor.c')).digest('hex'), sha256: createHash('sha256').update(readFileSync('out/sdk-supervisor')).digest('hex') }));
}
