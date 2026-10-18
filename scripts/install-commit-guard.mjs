import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Cannot locate Git hooks.');
  return result.stdout.trim();
}
const directory = git(['rev-parse', '--git-path', 'hooks']);
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--reviewer' || !['desktop', 'claude', 'codex', 'off'].includes(args[1]))) {
  throw new Error('Usage: npm run guard:install -- [--reviewer desktop|claude|codex|off]');
}
const target = join(directory, 'commit-msg');
const hook = readFileSync('.githooks/commit-msg', 'utf8');
if (existsSync(target) && readFileSync(target, 'utf8') !== hook) {
  throw new Error('Existing commit-msg hook found; integrate .githooks/commit-msg there instead of replacing it.');
}
mkdirSync(directory, { recursive: true });
const reviewer = args[1] ?? 'desktop';
if (reviewer === 'desktop' || existsSync('.claude/settings.local.json')) {
  const localPath = '.claude/settings.local.json';
  const settings = existsSync(localPath) ? JSON.parse(readFileSync(localPath, 'utf8')) : {};
  const template = reviewer === 'desktop' ? JSON.parse(readFileSync('scripts/commit-guard.desktop.json', 'utf8')) : { hooks: { PreToolUse: [] } };
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || (settings.hooks && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)))
    || (settings.hooks?.PreToolUse && !Array.isArray(settings.hooks.PreToolUse))) {
    throw new Error('Invalid local Claude settings; refusing to overwrite them.');
  }
  settings.hooks ??= {};
  const existing = settings.hooks.PreToolUse ?? [];
  const retained = existing.map(group => ({ ...group, hooks: group.hooks.filter(hook =>
    hook.statusMessage !== 'Reviewing commit confidentiality') })).filter(group => group.hooks.length);
  settings.hooks.PreToolUse = [...retained, ...template.hooks.PreToolUse];
  mkdirSync('.claude', { recursive: true });
  writeFileSync(localPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}
writeFileSync(target, hook, { mode: 0o755 });
chmodSync(target, 0o755);
git(['config', '--local', 'commitGuard.reviewer', reviewer]);
console.log(reviewer === 'off'
  ? 'Model confidentiality review explicitly off for this repository; deterministic artifact checks remain enabled. No model review will run. Linked worktrees share this local setting.'
  : `Commit confidentiality review enabled (${reviewer}). Desktop mode needs Node 24+ and Claude Code Desktop, with no standalone Claude CLI. Restart the Code session and review/trust the local hooks.`);
