import { randomUUID } from "node:crypto";
import { z } from "zod";
import { questionsSchema, responseSchema, type AgentRequest, type AgentResponse } from "../shared/interactions";
import type { Source } from "../shared/types";

export const REQUEST_TIMEOUT_MS = 300_000;
const inputSchema = z.object({
  session_id: z.string().min(1).max(200), cwd: z.string().max(4000).optional(),
  hook_event_name: z.enum(["PermissionRequest", "PreToolUse"]),
  tool_name: z.string().min(1).max(200), tool_input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string().min(1).max(200).optional(),
}).passthrough();
interface Pending {
  request: AgentRequest;
  input: Record<string, unknown>;
  correlation?: string;
  send(output: string): Promise<void>;
  expire(): void;
  timer: NodeJS.Timeout;
  responding: boolean;
}

// Pending requests are bound to live hook connections. They cannot be replayed
// from disk after an agent/deck restart or reused to authorize later tool calls.
export class InteractionQueue {
  private pending = new Map<string, Pending>();
  private delivered = new Map<string, string>();
  constructor(private changed: () => void, private timeout = REQUEST_TIMEOUT_MS) {}
  snapshot(): AgentRequest[] { return [...this.pending.values()].map(p => p.request); }
  add(source: Source, raw: unknown, send: Pending["send"], expire: Pending["expire"]): string {
    if (!source.responsesEnabled || !["claude", "codex"].includes(source.provider)) throw new Error("Responses are disabled");
    if (this.pending.size >= 8) throw new Error("Response queue is full");
    const payload = inputSchema.parse(raw);
    const question = payload.hook_event_name === "PreToolUse";
    if (question && (source.provider !== "claude" || payload.tool_name !== "AskUserQuestion")) throw new Error("Unsupported question tool");
    if (!question && payload.tool_name === "AskUserQuestion") throw new Error("Questions must use PreToolUse");
    const questions = question ? questionsSchema.parse(payload.tool_input.questions) : [];
    const correlation = payload.tool_use_id ? `${source.id}\n${payload.session_id}\n${payload.tool_use_id}\n${payload.hook_event_name}` : undefined;
    if (correlation && [...this.pending.values()].some(p => p.correlation === correlation)) throw new Error("Request already waiting");
    const id = randomUUID();
    const request: AgentRequest = {
      id, sourceId: source.id, provider: source.provider as "claude" | "codex", sourceName: source.name,
      sessionId: payload.session_id, cwd: payload.cwd ?? "", chatName: "", projectName: "",
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.timeout).toISOString(),
      kind: question ? "question" : "permission", toolName: payload.tool_name,
      description: typeof payload.tool_input.description === "string" ? payload.tool_input.description.slice(0,4000) : "",
      input: JSON.stringify(payload.tool_input, null, 2), questions,
    };
    const timer = setTimeout(() => this.cancel(id), this.timeout);
    timer.unref();
    this.pending.set(id, { request, input: payload.tool_input, correlation, send, expire, timer, responding: false });
    this.changed();
    return id;
  }
  detach(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(id); this.changed();
  }
  cancel(id: string): void { const p = this.pending.get(id); this.detach(id); p?.expire(); }
  cancelSource(sourceId: string): void { for (const p of this.pending.values()) if (p.request.sourceId === sourceId) this.cancel(p.request.id); }
  cancelSession(sourceId: string, sessionId: unknown): void {
    for (const p of this.pending.values()) if (p.request.sourceId === sourceId && p.request.sessionId === sessionId) this.cancel(p.request.id);
  }
  clear(): void { for (const id of this.pending.keys()) this.cancel(id); this.delivered.clear(); }
  async answer(raw: unknown): Promise<void> {
    const response: AgentResponse = responseSchema.parse(raw);
    const signature = JSON.stringify(response);
    if (this.delivered.get(response.id) === signature) return; // Retry a lost IPC acknowledgement without resending.
    const p = this.pending.get(response.id);
    if (!p || Date.parse(p.request.expiresAt) <= Date.now()) throw new Error("This request is no longer waiting. Continue in the agent’s own interface.");
    if (p.responding) throw new Error("The response is already being sent");
    if (p.request.kind !== response.kind) throw new Error("Response does not match this request");
    let output: unknown;
    if (response.kind === "permission") {
      output = response.decision === "defer" ? null : { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: response.decision, ...(response.decision === "deny" ? { message: "Denied by the user in Agent Control Deck." } : {}) } } };
    } else {
      if (response.answers.length !== p.request.questions.length) throw new Error("Answer every question");
      const answers: Record<string,string> = Object.create(null);
      p.request.questions.forEach((question,index) => {
        const value = response.answers[index];
        if (Array.isArray(value) && (!question.multiSelect || new Set(value).size !== value.length || value.some(label => !question.options.some(o => o.label === label)))) throw new Error("Choose valid options for this question");
        answers[question.question] = Array.isArray(value) ? value.join(", ") : value;
      });
      output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...p.input, answers } } };
    }
    p.responding = true;
    try {
      await p.send(output ? JSON.stringify(output) : "");
      this.delivered.set(response.id,signature);
      if (this.delivered.size > 32) this.delivered.delete(this.delivered.keys().next().value!);
      this.detach(response.id);
    } catch (error) { p.responding = false; throw error; }
  }
}
