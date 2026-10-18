// Test-build-only wrapper around the real production adapter. No secret in IPC.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runClaude as productionRun, type AgentRunner } from "../src/main/embedded-sdk";
const control = { calls: 0, latestQueryId: "", models: [] as string[], pids: [] as { pid: number; exited: boolean }[] };
(globalThis as any).acdLiveAcceptance = control;
export const runClaude: AgentRunner = async (prompt, options) => {
  const url = process.env.ACD_ACCEPTANCE_GATE_URL, token = process.env.ACD_ACCEPTANCE_GATE_TOKEN;
  if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || !token || control.calls >= 9) throw new Error("Acceptance dispatch refused");
  control.calls++; control.latestQueryId = randomUUID();
  const q = await productionRun(prompt, { ...options, model: "deepseek/deepseek-v4.1-flash-1017", maxTurns: 2, maxBudgetUsd: 0.25, thinking: { type: "disabled" },
    env: { ...options.env, ANTHROPIC_BASE_URL: url, ANTHROPIC_CUSTOM_HEADERS: `X-Acd-Acceptance: ${token}\nX-Acd-Query: ${control.latestQueryId}`, NO_PROXY: `127.0.0.1,localhost,${options.env?.NO_PROXY ?? ""}`, no_proxy: `127.0.0.1,localhost,${options.env?.no_proxy ?? ""}` },
    stderr: () => {}, spawnClaudeCodeProcess(s) {
      const p = spawn(s.command, s.args, { cwd: s.cwd, env: s.env, signal: s.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      p.stderr.on("data", () => {});
      const record = { pid: p.pid!, exited: false }; control.pids.push(record); p.once("exit", () => { record.exited = true; });
      return p;
    } });
  return { close: () => q.close(), waitForExit: () => q.waitForExit!(), async *[Symbol.asyncIterator]() {
    for await (const m of q) { if (m.type === "assistant") control.models.push(m.message.model); yield m; }
  } };
};
