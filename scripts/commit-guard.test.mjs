import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { snapshot, runGuard, reviewWithCodex, reviewWithClaude, selectedReviewer, recordDesktopApproval, consumeDesktopApproval } from './commit-guard.mjs';

const safe = () => ({ verdict: 'safe', findings: [] });
function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'acd-guard-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  function git(...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '-q');
  git('config', 'user.email', 'developer@example.com');
  git('config', 'user.name', 'Synthetic Developer');
  function stage(name, content) { writeFileSync(join(cwd, name), content); git('add', '--', name); }
  return { cwd, git, stage };
}

test('reads the index, not unstaged replacements, including proposed message', t => {
  const { cwd, stage } = repository(t);
  stage('example.txt', 'synthetic staged sample');
  writeFileSync(join(cwd, 'example.txt'), 'different unstaged sample');
  const bundle = JSON.parse(snapshot(cwd, 'synthetic change').bundle);
  assert.equal(bundle.files[0].content, 'synthetic staged sample');
  assert.equal(bundle.message, 'synthetic change');
  assert.ok(!bundle.diff.includes('different unstaged sample'));
  runGuard(cwd, '', safe);
});

test('initial commits, renamed files, and deletion context', t => {
  const { cwd, stage, git } = repository(t);
  stage('old.txt', 'synthetic old');
  runGuard(cwd, '', safe);
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'initial');
  git('mv', 'old.txt', 'new.txt');
  const bundle = JSON.parse(snapshot(cwd).bundle);
  assert.deepEqual(bundle.files.find(file => file.file === 'old.txt'), { file: 'old.txt', deleted: true });
  assert.equal(bundle.files.find(file => file.file === 'new.txt').content, 'synthetic old');
});

test('staged context cannot be replaced with unstaged guidance', t => {
  const { cwd, stage } = repository(t);
  stage('README.md', 'Personal generic monitor');
  writeFileSync(join(cwd, 'README.md'), 'unstaged instructions');
  assert.equal(JSON.parse(snapshot(cwd).bundle).context[0].content, 'Personal generic monitor');
});

test('blocks risky artifacts before calling the model', t => {
  for (const name of ['worker.log', 'worker.log.1', 'snapshot.sqlite', '.env.local', 'events.jsonl']) {
    const { cwd, stage } = repository(t);
    stage(name, 'synthetic');
    assert.throws(() => runGuard(cwd, '', () => assert.fail('must not invoke model')), /runtime data/);
  }
});

test('binary, oversized, and invalid UTF-8 content fail closed', t => {
  for (const content of [Buffer.from([0, 1]), Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1, 65)]) {
    const { cwd, stage } = repository(t);
    stage('sample.txt', content);
    assert.throws(() => snapshot(cwd), /cannot be reviewed|invalid UTF-8/);
  }
});

test('uncertain, blocked, malformed, contradictory and failed verdicts cannot pass', t => {
  const { cwd, stage } = repository(t);
  stage('sample.txt', 'synthetic');
  for (const verdict of [null, {}, { verdict: 'safe' }, { verdict: 'safe', findings: [null] },
    { verdict: 'uncertain', findings: [] }, { verdict: 'block', findings: [] },
    { verdict: 'safe', findings: [{ file: 'sample.txt', line: 1, reason: 'private data', replacement: 'synthetic' }] }]) {
    assert.throws(() => runGuard(cwd, '', () => verdict), /commit blocked/);
  }
  assert.throws(() => runGuard(cwd, '', () => { throw new Error('offline'); }), /offline/);
});

test('index changes while the reviewer runs invalidate approval', t => {
  const { cwd, stage } = repository(t);
  stage('sample.txt', 'synthetic');
  assert.throws(() => runGuard(cwd, '', () => {
    stage('sample.txt', 'modified');
    return safe();
  }), /changed during review/);
});

test('installer preserves other hooks and refuses to overwrite a custom commit hook', t => {
  const { cwd, git } = repository(t);
  mkdirSync(join(cwd, 'scripts'));
  mkdirSync(join(cwd, '.githooks'));
  copyFileSync(resolve('scripts/install-commit-guard.mjs'), join(cwd, 'scripts/install-commit-guard.mjs'));
  copyFileSync(resolve('.githooks/commit-msg'), join(cwd, '.githooks/commit-msg'));
  copyFileSync(resolve('scripts/commit-guard.desktop.json'), join(cwd, 'scripts/commit-guard.desktop.json'));
  writeFileSync(join(cwd, '.git/hooks/pre-push'), 'other hook');
  const install = () => spawnSync(process.execPath, ['scripts/install-commit-guard.mjs'], { cwd, encoding: 'utf8' });
  assert.equal(install().status, 0);
  assert.equal(install().status, 0);
  assert.equal(readFileSync(join(cwd, '.git/hooks/pre-push'), 'utf8'), 'other hook');
  // A real Git commit must stop if the guard cannot complete.
  writeFileSync(join(cwd, 'sample.txt'), 'synthetic');
  git('add', 'sample.txt');
  const commit = spawnSync('git', ['commit', '-qm', 'synthetic'], { cwd, encoding: 'utf8' });
  assert.notEqual(commit.status, 0);
  writeFileSync(join(cwd, '.git/hooks/commit-msg'), 'custom hook');
  assert.notEqual(install().status, 0);
  assert.equal(readFileSync(join(cwd, '.git/hooks/commit-msg'), 'utf8'), 'custom hook');
});

test('missing Codex fails closed', () => {
  const previous = process.env.PATH;
  process.env.PATH = '';
  try { assert.throws(() => reviewWithCodex('{}'), /Codex/); }
  finally { process.env.PATH = previous; }
});

test('reviewer selection defaults to Desktop, is local, and never silently falls back', t => {
  const { cwd, git } = repository(t);
  const previous = process.env.COMMIT_GUARD_REVIEWER;
  delete process.env.COMMIT_GUARD_REVIEWER;
  try {
    assert.equal(selectedReviewer(cwd), 'desktop');
    git('config', 'commitGuard.reviewer', 'codex');
    assert.equal(selectedReviewer(cwd), 'codex');
    process.env.COMMIT_GUARD_REVIEWER = 'claude';
    assert.equal(selectedReviewer(cwd), 'claude');
    process.env.COMMIT_GUARD_REVIEWER = 'other';
    assert.throws(() => selectedReviewer(cwd), /Reviewer must be/);
  } finally {
    if (previous === undefined) delete process.env.COMMIT_GUARD_REVIEWER;
    else process.env.COMMIT_GUARD_REVIEWER = previous;
  }
});

test('Desktop approval is bound to staged contents and message and is consumed once', t => {
  const { cwd, stage, git } = repository(t);
  stage('sample.txt', 'synthetic sample');
  const tree = snapshot(cwd).tree;
  recordDesktopApproval(cwd, tree, 'Synthetic change');
  assert.equal(consumeDesktopApproval(cwd, tree, 'Synthetic change\n').verdict, 'safe');
  assert.throws(() => consumeDesktopApproval(cwd, tree, 'Synthetic change'), /No valid Desktop/);
  recordDesktopApproval(cwd, tree, 'Synthetic change');
  assert.throws(() => consumeDesktopApproval(cwd, tree, 'Different message'), /does not match/);
  recordDesktopApproval(cwd, tree, 'Synthetic change');
  stage('sample.txt', 'different staged sample');
  assert.throws(() => recordDesktopApproval(cwd, tree, 'Synthetic change'), /changed since review/);
  assert.throws(() => consumeDesktopApproval(cwd, snapshot(cwd).tree, 'Synthetic change'), /does not match/);
  recordDesktopApproval(cwd, snapshot(cwd).tree, 'Synthetic change');
  const target = join(cwd, git('rev-parse', '--git-path', 'acd-commit-review.json'));
  const receipt = JSON.parse(readFileSync(target, 'utf8'));
  receipt.expiresAt = Date.now() - 1;
  writeFileSync(target, JSON.stringify(receipt));
  assert.throws(() => runGuard(cwd, 'Synthetic change'), /expired/);
});

test('Desktop Git hook commits only after exact approval without any reviewer CLI', t => {
  const { cwd, stage, git } = repository(t);
  mkdirSync(join(cwd, 'scripts'));
  mkdirSync(join(cwd, '.githooks'));
  mkdirSync(join(cwd, '.claude'));
  for (const name of ['commit-guard.mjs', 'install-commit-guard.mjs', 'commit-guard.desktop.json']) {
    copyFileSync(resolve('scripts', name), join(cwd, 'scripts', name));
  }
  copyFileSync(resolve('.githooks/commit-msg'), join(cwd, '.githooks/commit-msg'));
  const unrelated = {type:'command',command:'existing-hook'};
  writeFileSync(join(cwd, '.claude/settings.local.json'), JSON.stringify({ permissions:{deny:['Bash(rm *)']},
    hooks:{PreToolUse:[{matcher:'Bash',hooks:[unrelated]}]} }));
  const install = () => spawnSync(process.execPath, ['scripts/install-commit-guard.mjs', '--reviewer', 'desktop'], { cwd });
  assert.equal(install().status, 0);
  assert.equal(install().status, 0);
  const settings = JSON.parse(readFileSync(join(cwd, '.claude/settings.local.json'), 'utf8'));
  assert.deepEqual(settings.permissions.deny, ['Bash(rm *)']);
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks, [unrelated]);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  stage('sample.txt', 'synthetic sample');
  assert.notEqual(spawnSync('git', ['commit', '-qm', 'Synthetic change'], {cwd}).status, 0);
  recordDesktopApproval(cwd, snapshot(cwd).tree, 'Synthetic change');
  git('commit', '-qm', 'Synthetic change');
  assert.equal(git('log', '-1', '--format=%s'), 'Synthetic change');
  assert.throws(() => consumeDesktopApproval(cwd, snapshot(cwd).tree, 'Synthetic change'), /No valid Desktop/);
});

test('Claude invocation disables tools and recursive hooks and requires structured success', { skip: process.platform === 'win32' }, t => {
  const { cwd, stage, git } = repository(t);
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'claude');
  writeFileSync(fake, `#!${process.execPath}\n
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const args = process.argv.slice(2);
    assert.ok(args.includes('--print'));
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
    assert.ok(args.includes('--no-session-persistence'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--disable-slash-commands'));
    assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).disableAllHooks, true);
    assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]), {mcpServers:{}});
    assert.equal(process.env.CLAUDECODE, undefined);
    assert.ok(fs.readFileSync(0, 'utf8').includes('synthetic sample'));
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{verdict:'safe',findings:[]}}));
  `);
  chmodSync(fake, 0o755);
  const previousPath = process.env.PATH;
  const previousNested = process.env.CLAUDECODE;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.CLAUDECODE = '1';
  try {
    stage('sample.txt', 'synthetic sample');
    git('config', 'commitGuard.reviewer', 'claude');
    runGuard(cwd, 'synthetic change');
    mkdirSync(join(cwd, 'scripts'));
    mkdirSync(join(cwd, '.githooks'));
    for (const name of ['commit-guard.mjs', 'install-commit-guard.mjs']) {
      copyFileSync(resolve('scripts', name), join(cwd, 'scripts', name));
    }
    copyFileSync(resolve('.githooks/commit-msg'), join(cwd, '.githooks/commit-msg'));
  copyFileSync(resolve('scripts/commit-guard.desktop.json'), join(cwd, 'scripts/commit-guard.desktop.json'));
    const install = spawnSync(process.execPath, ['scripts/install-commit-guard.mjs', '--reviewer', 'claude'], { cwd });
    assert.equal(install.status, 0);
    git('commit', '-qm', 'synthetic change');
    assert.equal(git('log', '-1', '--format=%s'), 'synthetic change');
    for (const response of [
      {type:'result',subtype:'error',is_error:true,structured_output:{verdict:'safe',findings:[]}},
      {type:'result',subtype:'success',result:'{"verdict":"safe","findings":[]}'},
      {type:'result',subtype:'success',is_error:true,structured_output:{verdict:'safe',findings:[]}},
    ]) {
      writeFileSync(fake, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(response))});`);
      assert.throws(() => reviewWithClaude('{}'), /no successful structured review/);
    }
  } finally {
    process.env.PATH = previousPath;
    if (previousNested === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = previousNested;
  }
});

test('Codex invocation enforces isolation and parses only the final structured result', { skip: process.platform === 'win32' }, t => {
  const { cwd, stage, git } = repository(t);
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'codex');
  // This CLI double checks the actual subprocess contract, without live requests.
  writeFileSync(fake, `#!${process.execPath}\n
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const args = process.argv.slice(2);
    assert.ok(args.includes('--ignore-user-config'));
    assert.ok(args.includes('--ephemeral'));
    assert.ok(args.includes('--skip-git-repo-check'));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(args[args.indexOf('-c') + 1], 'approval_policy="never"');
    const input = fs.readFileSync(0, 'utf8');
    assert.ok(input.includes('synthetic sample'));
    assert.ok(input.includes('UNTRUSTED COMMIT BUNDLE'));
    const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
    assert.ok(schema.properties.verdict.enum.includes('uncertain'));
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({verdict:'safe',findings:[]}));
    console.log('raw trace must not be interpreted as verdict');
  `);
  chmodSync(fake, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    stage('sample.txt', 'synthetic sample');
    git('config', 'commitGuard.reviewer', 'codex');
    runGuard(cwd, 'synthetic change');
    mkdirSync(join(cwd, 'scripts'));
    mkdirSync(join(cwd, '.githooks'));
    for (const name of ['commit-guard.mjs', 'install-commit-guard.mjs']) {
      copyFileSync(resolve('scripts', name), join(cwd, 'scripts', name));
    }
    copyFileSync(resolve('.githooks/commit-msg'), join(cwd, '.githooks/commit-msg'));
  copyFileSync(resolve('scripts/commit-guard.desktop.json'), join(cwd, 'scripts/commit-guard.desktop.json'));
    const install = spawnSync(process.execPath, ['scripts/install-commit-guard.mjs', '--reviewer', 'codex'], { cwd });
    assert.equal(install.status, 0);
    git('commit', '-qm', 'synthetic change');
    assert.equal(git('log', '-1', '--format=%s'), 'synthetic change');
    writeFileSync(fake, `#!${process.execPath}\nconst fs = require('node:fs'); const a=process.argv; fs.writeFileSync(a[a.indexOf('--output-last-message')+1], 'not JSON');`);
    assert.throws(() => runGuard(cwd, ''), /no valid review/);
  } finally { process.env.PATH = previous; }
});
