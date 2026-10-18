// Official SDK transport probe. Runtime credentials stay in backend memory.
// Live calls require ACD_EMBEDDED_LIVE=1 and --inference (may incur API cost).
import { embeddedConfig, connectionDiagnostic } from '../src/main/embedded-config.ts';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'acd-sdk-smoke-'));
const config = embeddedConfig();
const env = { ...config.env };
if (config.authMode !== 'claude-code') env.CLAUDE_CONFIG_DIR = directory;
const inference = process.argv.includes('--inference');
const options = { cwd: directory, env, model: config.model, settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: [], permissionMode: 'default', maxTurns: 1, maxBudgetUsd: 0.025, includePartialMessages: true, persistSession: true };
let active;
const abortController = new AbortController();
const timeout = setTimeout(() => { abortController.abort(); active?.close(); }, 25000);
try {
  console.log(`Official SDK 0.3.302; explicit authentication mode: ${config.authMode}`);
  if (!inference) {
    let release;
    const parked = new Promise(resolve => { release = resolve; });
    async function* prompt() { await parked; }
    active = query({ prompt: prompt(), options: { ...options, abortController } });
    try {
      await active.accountInfo();
      console.log('Official SDK subprocess initialization succeeded. No prompt submitted; no inference or tool call performed.');
    } finally { release(); active.close(); }
  } else {
    if (process.env.ACD_EMBEDDED_LIVE !== '1') throw new Error('Live inference requires ACD_EMBEDDED_LIVE=1 as well as --inference');
    if (config.diagnostic) throw new Error(config.diagnostic);
    let session;
    let turn = 0;
    for (const prompt of ['Remember the synthetic word orchard. Reply only READY. Do not use tools.', 'What synthetic word did I ask you to remember? Reply with only that word. Do not use tools.']) {
      let completed = false, output = "", streamed = false;
      const priorSession = session;
      active = query({ prompt, options: { ...options, abortController, resume: session } });
      for await (const message of active) {
        if ('session_id' in message && message.session_id) session = message.session_id;
        if (message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') streamed = true;
        if (message.type === 'assistant') for (const block of message.message.content) if (block.type === 'text') output += block.text;
        if (message.type === 'result') {
          completed = !message.is_error;
          console.log(`Inference result received; success: ${completed}; session captured: ${!!session}`);
        }
      }
      active.close();
      if (!completed || !streamed || !session || (priorSession && session !== priorSession) || output.trim().toLowerCase() !== (turn++ === 0 ? 'ready' : 'orchard')) throw new Error('Inference/streaming/resume assertion failed');
    }
    console.log('Two live SDK turns completed with resume. Response contents intentionally omitted.');
  }
} catch (error) {
  console.error(`SDK smoke failed. ${inference && process.env.ACD_EMBEDDED_LIVE !== '1' ? 'Live inference requires ACD_EMBEDDED_LIVE=1 and --inference.' : config.diagnostic ?? connectionDiagnostic(error)} No success claimed.`);
  process.exitCode = 1;
} finally { clearTimeout(timeout); active?.close(); rmSync(directory, { recursive: true, force: true }); }
