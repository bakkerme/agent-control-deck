// Synthetic transport events only. No SDK process, credentials or model calls.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner } from "../src/main/embedded-sdk";
export const fixtureAgent: AgentRunner = async (prompt, options) => {
  if (prompt === "fixture-error") throw new Error("Synthetic connection failure");
  const sdk = (value: unknown) => value as SDKMessage;
  const session_id = "22222222-2222-4222-8222-222222222222";
  return { close() {}, async *[Symbol.asyncIterator]() {
    yield sdk({ type: "system", subtype: "init", session_id });
    const id = `fixture-${Date.now()}`;
    yield sdk({ type: "stream_event", session_id, parent_tool_use_id: null, event: { type: "message_start", message: { id } } });
    yield sdk({ type: "stream_event", session_id, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Synthetic streaming response…" } } });
    await new Promise(resolve => setTimeout(resolve, 100));
    if (prompt === "fixture-permission" || prompt === "fixture-question") {
      const tool = prompt === "fixture-question" ? "AskUserQuestion" : "Write";
      const input = tool === "Write" ? { file_path: "synthetic-notes.txt", content: "Synthetic fixture only; never executed" } : { questions: [{ question: "Which synthetic option?", header: "Option", options: [{ label: "A" }, { label: "B" }] }] };
      const decision = await options.canUseTool!(tool, input, { signal: options.abortController!.signal, toolUseID: "fixture-tool", requestId: "fixture-request" });
      yield sdk({ type: "assistant", uuid: `${id}-assistant`, session_id, message: { id, content: [{ type: "text", text: `Synthetic ${tool} request ${decision?.behavior}. No tool executed.` }] } });
    } else {
      yield sdk({ type: "assistant", uuid: `${id}-assistant`, session_id, message: { id, content: [{ type: "text", text: "Synthetic fixture response. This is test evidence, not live Claude output." }, { type: "tool_use", id: `${id}-tool`, name: "Read", input: { file_path: "synthetic.txt" } }] } });
      yield sdk({ type: "user", session_id, message: { content: [{ type: "tool_result", tool_use_id: `${id}-tool`, content: "Synthetic tool result" }] } });
    }
    yield sdk({ type: "result", session_id, subtype: "success", is_error: false });
  } };
};
