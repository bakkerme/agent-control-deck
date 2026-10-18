// Backend only. This seam lets lifecycle tests run without credentials or model calls.
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn, ChildProcess } from "node:child_process";
export type AgentQuery = Pick<Query, "close"> & AsyncIterable<SDKMessage> & { waitForExit?(): Promise<void> };
export type AgentRunner = (prompt: string, options: Options) => Promise<AgentQuery>;
export const runClaude: AgentRunner = async (prompt, options) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", session_id: "", message: { role: "user", content: prompt }, parent_tool_use_id: null };
  }
  const exits: Promise<void>[] = [];
  const originalSpawn = options.spawnClaudeCodeProcess;
  const run = query({ prompt: input(), options: { ...options, spawnClaudeCodeProcess(spawnOptions) {
    const child = originalSpawn ? originalSpawn(spawnOptions) : spawn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd, env: spawnOptions.env, signal: spawnOptions.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    // Preserve the SDK's forwarded EOF/grace signal. A sent kill signal is not
    // proof of exit; exact-session ownership remains until this event arrives.
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", () => { if (child instanceof ChildProcess && !child.pid) reject(new Error("Agent process failed to start")); });
    });
    void exited.catch(() => {}); exits.push(exited);
    if (!originalSpawn && "stderr" in child) child.stderr?.on("data", (chunk: Buffer) => options.stderr?.(chunk.toString()));
    return child;
  } } });
  return { close: () => run.close(), waitForExit: async () => { try { await run.return(undefined); } catch { /* Exit is checked independently below. */ } await Promise.all(exits); }, [Symbol.asyncIterator]: () => run[Symbol.asyncIterator]() };
};
