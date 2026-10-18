// Linked only into out-tests/native-app. Never used by a production build.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner } from "../src/main/embedded-sdk";
const control = { calls: 0, effects: 0, releases: new Map<string, () => void>(),
  release(name: string) { this.releases.get(name)?.(); this.releases.delete(name); } };
(globalThis as unknown as { acdAcceptance: typeof control }).acdAcceptance = control;
export const runClaude: AgentRunner = async (prompt, options) => {
  control.calls++;
  const session_id = options.resume ?? randomUUID();
  const sdk = (value: unknown) => value as SDKMessage;
  return { close() {}, async *[Symbol.asyncIterator]() {
    yield sdk({ type: "system", subtype: "init", session_id });
    if (prompt === "Synthetic native question") {
      await options.canUseTool!("AskUserQuestion", { questions: [{ question: "Which synthetic option?", header: "Option", options: [{ label: "A" }, { label: "B" }] }] },
        { signal: options.abortController!.signal, requestId: "same-sdk-request", toolUseID: "same-tool" });
    } else if (prompt === "Synthetic native effect") {
      const result = await options.canUseTool!("Write", { file_path: join(options.cwd!, "effects.txt"), content: "synthetic" },
        { signal: options.abortController!.signal, requestId: "same-sdk-request", toolUseID: "same-tool" });
      if (result?.behavior === "allow" && !options.abortController!.signal.aborted) {
        appendFileSync(join(options.cwd!, "effects.txt"), "committed\n", { flush: true }); control.effects++;
        await new Promise<void>(resolve => control.releases.set("effectAck", resolve));
        yield sdk({ type: "user", session_id, message: { content: [{ type: "tool_result", tool_use_id: "same-tool", content: "synthetic acknowledgement" }] } });
      }
    }
    yield sdk({ type: "assistant", uuid: randomUUID(), session_id, message: { id: randomUUID(), content: [{ type: "text", text: prompt }] } });
    yield sdk({ type: "result", session_id, subtype: "success", is_error: false });
  } };
};
