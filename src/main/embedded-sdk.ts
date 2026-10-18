// Backend only. This seam lets lifecycle tests run without credentials or model calls.
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
export type AgentQuery = Pick<Query, "close"> & AsyncIterable<SDKMessage>;
export type AgentRunner = (prompt: string, options: Options) => Promise<AgentQuery>;
export const runClaude: AgentRunner = async (prompt, options) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", session_id: "", message: { role: "user", content: prompt }, parent_tool_use_id: null };
  }
  return query({ prompt: input(), options });
};
