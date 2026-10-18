// Test-build-only wrapper around the real production adapter. No secret in IPC.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runClaude as productionRun, spawnOwnedSdkProcess, type AgentRunner } from "../src/main/embedded-sdk";
const control = { calls: 0, latestQueryId: "", latestSupervisorPid: 0, models: [] as string[], pids: [] as { pid: number; startTime?: string; exited: boolean }[] };
(globalThis as any).acdLiveAcceptance = control;
export const runClaude: AgentRunner = async (prompt, options) => {
  const url = process.env.ACD_ACCEPTANCE_GATE_URL, token = process.env.ACD_ACCEPTANCE_GATE_TOKEN;
  if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || !token || control.calls >= 9) throw new Error("Acceptance dispatch refused");
  control.calls++; control.latestQueryId = randomUUID();
  const q = await productionRun(prompt, { ...options, model: "deepseek/deepseek-v4.1-flash-1017", maxTurns: 2, maxBudgetUsd: 0.25, thinking: { type: "disabled" },
    env: { ...options.env, ANTHROPIC_BASE_URL: url, ANTHROPIC_CUSTOM_HEADERS: `X-Acd-Acceptance: ${token}\nX-Acd-Query: ${control.latestQueryId}`, NO_PROXY: `127.0.0.1,localhost,${options.env?.NO_PROXY ?? ""}`, no_proxy: `127.0.0.1,localhost,${options.env?.no_proxy ?? ""}` },
    stderr: () => {}, spawnClaudeCodeProcess(s) {
      const p = spawnOwnedSdkProcess(s);
      p.stderr.on("data", () => {});
      let startTime: string | undefined; try { startTime = readFileSync(`/proc/${p.pid}/stat`, "utf8").split(") ")[1].split(" ")[19]; } catch {}
      control.latestSupervisorPid = p.pid!;
      const record = { pid: p.pid!, startTime, exited: false }; control.pids.push(record); p.once("exit", () => { record.exited = true; });
      void p.sdkPid?.then(pid => {
        let startTime: string | undefined; try { startTime = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[19]; } catch {}
        const sdk = { pid, startTime, exited: record.exited }; control.pids.push(sdk);
        p.once("exit", () => { sdk.exited = true; });
      }).catch(() => {});
      return p;
    } });
  return { close: () => q.close(), waitForExit: () => q.waitForExit!(), async *[Symbol.asyncIterator]() {
    for await (const m of q) { if (m.type === "assistant") control.models.push(m.message.model); yield m; }
  } };
};
