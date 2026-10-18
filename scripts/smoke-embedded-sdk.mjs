// Official SDK transport probe. No credentials are read or copied by this script.
// Pass --inference for two harmless, tools-disabled model turns (may incur API cost).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'acd-sdk-smoke-'));
const mode = process.env.ACD_EMBEDDED_AUTH === 'api-key' ? 'api-key' : 'claude-code';
const env = {};
for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) env[key] = process.env[key];
if (mode === 'api-key') { env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; env.CLAUDE_CONFIG_DIR = directory; }
const options = { cwd: directory, env, settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: [], permissionMode: 'default', maxTurns: 1, persistSession: true };
let active;
const abortController = new AbortController();
const timeout = setTimeout(() => { abortController.abort(); active?.close(); }, 25000);
try {
  console.log(`Official SDK 0.3.302; explicit authentication mode: ${mode}`);
  if (!process.argv.includes('--inference')) {
    let release;
    const parked = new Promise(resolve => { release = resolve; });
    async function* prompt() { await parked; }
    active = query({ prompt: prompt(), options: { ...options, abortController } });
    try {
      await active.accountInfo();
      console.log('Official SDK subprocess initialization succeeded. No prompt submitted; no inference or tool call performed.');
    } finally { release(); active.close(); }
  } else {
    if (mode === 'api-key' && !env.ANTHROPIC_API_KEY) throw new Error('Missing API key');
    let session;
    for (const prompt of ['Remember the synthetic word orchard. Reply only READY. Do not use tools.', 'What synthetic word did I ask you to remember? Reply with only that word. Do not use tools.']) {
      let completed = false;
      active = query({ prompt, options: { ...options, abortController, resume: session } });
      for await (const message of active) {
        if ('session_id' in message) session = message.session_id;
        if (message.type === 'result') {
          completed = !message.is_error;
          console.log(`Inference turn: ${message.subtype}; session captured: ${!!session}`);
        }
      }
      active.close();
      if (!completed) throw new Error('Inference did not complete');
    }
    console.log('Two live SDK turns completed with resume. Response contents intentionally omitted.');
  }
} catch {
  console.error('SDK smoke failed. Check supported local sign-in or explicit API-key mode, network and bundled binary installation. No success claimed.');
  process.exitCode = 1;
} finally { clearTimeout(timeout); active?.close(); rmSync(directory, { recursive: true, force: true }); }
