import type { Source, State } from "../shared/types";
import { codexPrompt, promptTitle } from "../shared/presentation";
import { hookEvents } from "./setup";

export interface Observation {
  externalId: string;
  workspace: string | null;
  kind: string;
  state?: State;
  lifecycle?: "open" | "ended";
  preview?: string;
  title?: string;
  summary: string;
  subagent?: { id: string | null; type: string; running: boolean };
  backgroundSubagents?: { id: string; type: string }[];
}
const text = (p: Record<string, unknown>, key: string): string =>
  typeof p[key] === "string" ? (p[key] as string) : "";
export function preview(value: string): string {
  return value
    .replace(/<\/?user_query>/gi, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, 500);
}
export function normalize(
  source: Source,
  payload: Record<string, unknown>,
): Observation | null {
  const event = text(payload, "hook_event_name");
  const subagentEvent = /^(Subagent|subagent)(Start|Stop)$/.test(event);
  const externalId =
    source.provider !== "cursor"
      ? text(payload, "session_id")
      : (subagentEvent ? text(payload, "parent_conversation_id") : "") || text(payload, "conversation_id") || text(payload, "session_id");
  const roots = payload.workspace_roots;
  const workspace =
    text(payload, "cwd") ||
    (Array.isArray(roots) && typeof roots[0] === "string" ? roots[0] : "") ||
    null;
  const known = [...hookEvents(source.provider), source.provider === "cursor" ? "sessionStart" : "SessionStart"];
  if (!known.includes(event)) return null;
  if (!externalId || externalId.length > 2000)
    throw new Error("Event is missing a valid conversation/session ID");
  const result: Observation = {
    externalId,
    workspace,
    kind: event,
    summary: event,
  };
  if (source.provider === "claude" && (event === "Stop" || event === "SubagentStop") && payload.background_tasks !== undefined) {
    if (!Array.isArray(payload.background_tasks) || payload.background_tasks.length > 1000)
      throw new Error("Invalid background task snapshot");
    result.backgroundSubagents = [];
    for (const task of payload.background_tasks) {
      if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error("Invalid background task");
      const fields = task as Record<string, unknown>;
      if (fields.type !== "subagent") continue;
      const id = text(fields, "id");
      if (!id || id.length > 2000) throw new Error("Background subagent is missing a valid ID");
      result.backgroundSubagents.push({ id, type: preview(text(fields, "agent_type")).slice(0, 200) });
    }
  }
  if (subagentEvent) {
    const id = text(payload, source.provider === "cursor" ? "subagent_id" : "agent_id");
    const running = event.endsWith("Start");
    if (id.length > 2000 || (running && !id)) throw new Error("Subagent is missing a valid ID");
    const type = preview(text(payload, source.provider === "cursor" ? "subagent_type" : "agent_type")).slice(0, 200);
    return {
      ...result,
      subagent: { id: id || null, type, running },
      summary: running ? `Subagent started${type ? `: ${type}` : ""}`
        : `Subagent finished responding${type ? `: ${type}` : ""}${!id ? " — identity unavailable" : ""}`,
    };
  }
  if (source.provider !== "cursor" && event === "SessionStart" && text(payload, "source") === "compact") {
    // Compaction can occur mid-turn; it is not evidence that work stopped.
    return { ...result, lifecycle: "open", summary: "Session context compacted" };
  }
  if (event === "Interrupt") {
    return { ...result, state: "idle", summary: "Turn interrupted" };
  }
  if (event === "PostToolUse" || event === "PostToolUseFailure" || event === "ElicitationResult") {
    // Answers and permission decisions resume the current turn without a new
    // UserPromptSubmit. A tool failure also returns control to Claude; only
    // StopFailure is evidence that the whole turn failed.
    if (event === "PostToolUseFailure" && payload.is_interrupt === true)
      return { ...result, state: "idle", summary: "Tool interrupted" };
    return {
      ...result,
      state: "running",
      summary: event === "ElicitationResult"
        ? "Input received — work resumed"
        : event === "PostToolUseFailure"
          ? "Tool returned an error — turn continuing"
          : "Tool completed — turn continuing",
    };
  }
  if (event === "SessionStart" || event === "sessionStart") {
    return {
      ...result,
      state: "idle",
      lifecycle: "open",
      summary: "Session opened",
    };
  }
  if (event === "UserPromptSubmit" || event === "beforeSubmitPrompt") {
    const rawPrompt = text(payload, "prompt");
    const codex = source.provider === "codex";
    const displayPrompt = codex ? codexPrompt(rawPrompt) : null;
    const prompt = preview(displayPrompt ? displayPrompt.content || displayPrompt.attachment : rawPrompt);
    return {
      ...result,
      state: "running",
      lifecycle: "open",
      preview: prompt || undefined,
      title: promptTitle(rawPrompt, codex) || undefined,
      summary: prompt ? `Prompt: ${prompt}`.slice(0, 500) : "Prompt submitted",
    };
  }
  if (event === "afterAgentResponse") {
    const response = preview(text(payload, "text"));
    return {
      ...result,
      preview: response || undefined,
      summary: response || "Assistant responded",
    };
  }
  if (event === "Stop" || event === "stop") {
    const failed = text(payload, "status") === "error";
    const response = preview(text(payload, "last_assistant_message"));
    return {
      ...result,
      state: failed ? "error" : "idle",
      preview: response || undefined,
      summary: failed
        ? "Turn failed"
        : text(payload, "status") === "aborted"
          ? "Turn stopped"
          : "Turn complete — session idle",
    };
  }
  if (event === "StopFailure")
    return {
      ...result,
      state: "error",
      summary:
        preview(text(payload, "error") || text(payload, "error_details")) ||
        "Turn failed",
    };
  if (event === "SessionEnd" || event === "sessionEnd")
    return {
      ...result,
      state: text(payload, "reason") === "error" ? "error" : "idle",
      lifecycle: "ended",
      summary: `Session ended${text(payload, "reason") ? `: ${preview(text(payload, "reason"))}` : ""}`,
    };
  if (event === "Notification") {
    const type = text(payload, "notification_type");
    if (type === "permission_prompt" || type === "elicitation_dialog")
      return {
        ...result,
        state: "waiting",
        summary: preview(text(payload, "message")) || "Needs your attention",
      };
    if (type === "idle_prompt")
      return {
        ...result,
        state: "idle",
        summary: "Waiting for your next prompt",
      };
    return {
      ...result,
      summary: preview(text(payload, "message")) || "Notification received",
    };
  }
  return null;
}
