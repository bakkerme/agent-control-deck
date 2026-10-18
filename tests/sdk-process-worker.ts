// Real official SDK subprocess, parked user input: no inference request.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { join } from "node:path";
const root = process.argv[2], abortController = new AbortController();
let release!: () => void;
const parked = new Promise<void>(resolve => { release = resolve; });
async function* input(): AsyncGenerator<any> { await parked; }
const q = query({ prompt: input(), options: { cwd: root, env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(root, "sdk"), ANTHROPIC_API_KEY: "" },
  settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: [], abortController,
  spawnClaudeCodeProcess(options) {
    const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", () => {});
    child.once("exit", (code, signal) => process.send?.({ sdkExit: true, code, signal }));
    process.send?.({ sdkPid: child.pid });
    return child;
  } } });
// Consume the SDK iterator as the production adapter does; cancellation can
// reject that iterator and is an expected terminal path, not an unhandled task.
void (async () => { try { for await (const _message of q) { /* No prompt, no result expected. */ } } catch { /* Cancellation/EOF is exercised by parent. */ } })();
process.on("message", message => { if (message === "cancel") abortController.abort(); if (message === "close") q.close(); if (message === "stop") { release(); q.close(); process.disconnect(); } });
void q.accountInfo().then(() => process.send?.({ ready: true }), () => { process.send?.({ failed: true }); q.close(); });
