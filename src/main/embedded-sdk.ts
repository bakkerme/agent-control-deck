// Backend only. This seam lets lifecycle tests run without credentials or model calls.
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ChildProcess } from "node:child_process";
import { spawnOwnedSdkProcess } from "./embedded-process";
export { spawnOwnedSdkProcess } from "./embedded-process";
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
    const child = originalSpawn ? originalSpawn(spawnOptions) : spawnOwnedSdkProcess(spawnOptions);
    // Preserve the SDK's forwarded EOF/grace signal. A sent kill signal is not
    // proof of exit; exact-session ownership remains until this event arrives.
    const exited = observeAgentExit(child);
    void exited.catch(() => {}); exits.push(exited);
    if (!originalSpawn && "stderr" in child) child.stderr?.on("data", (chunk: Buffer) => options.stderr?.(chunk.toString()));
    return child;
  } } });
  return { close: () => run.close(), waitForExit: async () => { try { await run.return(undefined); } catch { /* Exit is checked independently below. */ } await Promise.all(exits); }, [Symbol.asyncIterator]: () => run[Symbol.asyncIterator]() };
};

export function observeAgentExit(child: ReturnType<NonNullable<Options["spawnClaudeCodeProcess"]>>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once("exit", (_code, signal) => {
      if ("ownedSupervisor" in child && child.ownedSupervisor && signal) reject(new Error("Agent supervisor shutdown is unconfirmed"));
      else resolve();
    });
    // Node proves no child exists when spawn fails without a PID. Custom
    // remote spawners must still report their own definitive exit.
    child.once("error", () => { if (child instanceof ChildProcess && !child.pid) resolve(); });
  });
}
