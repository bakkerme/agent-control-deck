import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "./store";
import { embeddedCommandSchema, questionsSchema, type EmbeddedChat, type EmbeddedEvent, type EmbeddedReply, type EmbeddedRequest } from "../shared/embedded-chat";
import { embeddedConfig, connectionDiagnostic, type EmbeddedConfig } from "./embedded-config";
import { runClaude, type AgentQuery, type AgentRunner } from "./embedded-sdk";

type Pending = { request: EmbeddedRequest; input: Record<string, unknown>; resolve: (value: PermissionResult) => void };
async function startedQuery(start: Promise<AgentQuery>, signal: AbortSignal): Promise<AgentQuery> {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(new Error("Cancelled")); };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    // Startup can settle after cancellation has released the Deck turn. Always
    // observe rejection and close a late query, without handing it to a new run.
    void start.then(query => {
      signal.removeEventListener("abort", aborted);
      if (signal.aborted) { try { query.close(); } catch { /* Already cancelled. */ } return; }
      resolve(query);
    }, error => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}
async function nextMessage(iterator: AsyncIterator<SDKMessage>, signal: AbortSignal): Promise<IteratorResult<SDKMessage>> {
  if (signal.aborted) throw new Error("Cancelled");
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(new Error("Cancelled")); };
    signal.addEventListener("abort", aborted, { once: true });
    void iterator.next().then(value => { signal.removeEventListener("abort", aborted); resolve(value); }, error => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}
type Running = { abort: AbortController; query?: AgentQuery; pending: Map<string, Pending>; done?: Promise<void> };
const stamp = () => new Date().toISOString();
const cap = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value) ?? "").slice(0, 30000);
export class EmbeddedChats {
  private runs = new Map<string, Running>();
  private disposed = false;
  constructor(private store: Store, private root: string, private changed: () => void,
    private enabled = process.env.ACD_EMBEDDED_CHAT === "1", private runner: AgentRunner = runClaude,
    private config: EmbeddedConfig = embeddedConfig()) {
    // A restarted process cannot continue pending approvals or claim work is running.
    const interrupted = store.db.prepare("SELECT c.id FROM chats c JOIN embedded_sessions s ON s.chatId=c.id WHERE c.state IN ('running','waiting')").all() as { id: string }[];
    for (const { id } of interrupted) {
      this.event(id, randomUUID(), "notice", "App restarted; previous turn interrupted. Send a follow-up to resume. Pending approvals were discarded.");
      this.state(id, "idle");
    }
  }
  private status(): EmbeddedReply { return { enabled: this.enabled, configured: !this.config.diagnostic, authMode: this.config.authMode, provider: this.config.provider, model: this.config.model, helperModel: this.config.helperModel, diagnostic: this.config.diagnostic }; }
  private require(id: string): { cwd: string; sessionId: string | null; configIdentity: string | null; model: string | null; provider: string | null } {
    const row = this.store.db.prepare("SELECT cwd,sessionId,configIdentity,model,provider FROM embedded_sessions WHERE chatId=?").get(id) as { cwd: string; sessionId: string | null; configIdentity: string | null; model: string | null; provider: string | null } | undefined;
    if (!row) throw new Error("Choose an embedded chat");
    return row;
  }
  private state(id: string, state: string): void {
    this.store.db.prepare("UPDATE chats SET state=?,lastEventAt=?,updatedAt=? WHERE id=?").run(state, stamp(), stamp(), id);
    this.changed();
  }
  private event(id: string, eventId: string, kind: EmbeddedEvent["kind"], text: string): void {
    if (this.disposed) return;
    this.store.db.transaction(() => {
      this.store.db.prepare("INSERT INTO embedded_events(id,chatId,kind,text,at) VALUES(?,?,?,?,?) ON CONFLICT(chatId,id) DO UPDATE SET text=excluded.text").run(eventId, id, kind, cap(this.redact(text)), stamp());
      this.store.db.prepare("DELETE FROM embedded_events WHERE chatId=? AND sequence NOT IN (SELECT sequence FROM embedded_events WHERE chatId=? ORDER BY sequence DESC LIMIT 500)").run(id, id);
      this.store.db.prepare("UPDATE chats SET preview=?,lastEventAt=?,updatedAt=? WHERE id=?").run(cap(this.redact(text)).slice(0, 500), stamp(), stamp(), id);
    })();
    this.changed();
  }
  private redact(text: string): string {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
      const secret = this.config.env[key];
      if (secret) text = text.split(secret).join("[redacted]");
    }
    return text;
  }
  private read(id: string): EmbeddedChat {
    const { configIdentity: _identity, ...session } = this.require(id), chat = this.store.chat(id), run = this.runs.get(id);
    const events = this.store.db.prepare("SELECT id,kind,text,at FROM embedded_events WHERE chatId=? ORDER BY sequence").all(id) as EmbeddedEvent[];
    return { chatId: id, name: chat.name, ...session, state: chat.state, events, requests: [...(run?.pending.values() ?? [])].map(p => p.request), active: !!run };
  }
  async command(raw: unknown): Promise<EmbeddedReply> {
    const c = embeddedCommandSchema.parse(raw);
    if (c.type === "status") return this.status();
    if (!this.enabled || this.disposed) throw new Error("Embedded chat experiment is disabled. Start with ACD_EMBEDDED_CHAT=1.");
    if (c.type === "list") {
      const ids = this.store.db.prepare("SELECT s.chatId FROM embedded_sessions s JOIN plan_chats p ON p.chatId=s.chatId WHERE p.itemId=? ORDER BY s.rowid").all(c.taskId) as { chatId: string }[];
      return { ...this.status(), chats: ids.map(r => this.read(r.chatId)) };
    }
    if (c.type === "create") {
      if (!isAbsolute(c.cwd)) throw new Error("Choose an absolute local working directory");
      const cwd = realpathSync(c.cwd);
      if (!statSync(cwd).isDirectory()) throw new Error("Working directory must be a local folder");
      const task = this.store.db.prepare("SELECT projectId FROM plan_items WHERE id=?").get(c.taskId) as { projectId: string | null } | undefined;
      if (!task) throw new Error("Choose an existing task");
      const id = randomUUID();
      this.store.db.transaction(() => {
        this.store.db.prepare("INSERT INTO chats(id,projectId,provider,name,state,createdAt,updatedAt) VALUES(?,?,'claude',?,'idle',?,?)").run(id, task.projectId, c.name, stamp(), stamp());
        this.store.db.prepare("INSERT INTO embedded_sessions(chatId,cwd,configIdentity,model,provider) VALUES(?,?,?,?,?)").run(id, cwd, this.config.identity, this.config.model ?? null, this.config.provider);
        this.store.db.prepare("INSERT INTO plan_chats(itemId,chatId,origin) VALUES(?,?,'manual')").run(c.taskId, id);
      })();
      this.changed();
      return { ...this.status(), chat: this.read(id) };
    }
    this.require(c.chatId);
    if (c.type === "send") {
      const hash = createHash("sha256").update(c.text).digest("hex");
      const prior = this.store.db.prepare("SELECT promptHash FROM embedded_sends WHERE chatId=? AND sendId=?").get(c.chatId, c.sendId) as { promptHash: string } | undefined;
      if (prior) {
        if (prior.promptHash !== hash) throw new Error("This send identifier was already used for a different message");
        return { ...this.status(), chat: this.read(c.chatId) };
      }
      if (this.config.diagnostic) throw new Error(this.config.diagnostic);
      const session = this.require(c.chatId);
      if (session.configIdentity !== this.config.identity) throw new Error("Provider/model configuration changed or this is a legacy session. Create a new embedded chat for the task; previous history is retained.");
      if (this.runs.has(c.chatId)) throw new Error("Wait for the current turn or cancel it");
      if (this.runs.size >= 3) throw new Error("Three embedded turns are already running");
      const run: Running = { abort: new AbortController(), pending: new Map() };
      this.runs.set(c.chatId, run);
      try {
        this.store.db.transaction(() => {
          this.store.db.prepare("INSERT INTO embedded_sends(chatId,sendId,promptHash) VALUES(?,?,?)").run(c.chatId, c.sendId, hash);
          this.event(c.chatId, `send:${c.sendId}`, "user", c.text);
          this.state(c.chatId, "running");
        })();
        run.done = this.execute(c.chatId, c.text, run);
      } catch (error) { this.runs.delete(c.chatId); throw error; }
    }
    if (c.type === "cancel") this.cancel(c.chatId);
    if (c.type === "decide") {
      const run = this.runs.get(c.chatId), pending = run?.pending.get(c.requestId);
      if (!run || !pending || run.abort.signal.aborted) throw new Error("This request has expired");
      let input = pending.input;
      if (c.allow && pending.request.questions) {
        const questions = pending.request.questions;
        if (!c.answers || Object.keys(c.answers).length !== questions.length || questions.some(q => !c.answers?.[q.question]?.trim())) throw new Error("Answer each question before sending");
        if (Object.keys(c.answers).some(key => !questions.some(q => q.question === key))) throw new Error("Unknown question");
        input = { ...input, answers: c.answers };
      } else if (c.answers) throw new Error("This request does not accept answers");
      // Persist before consuming the waiter: a failed write must leave the
      // request available for retry/denial, without authorizing an effect.
      this.event(c.chatId, randomUUID(), "notice", `${c.allow ? "Allowed once" : "Denied"}: ${pending.request.tool}`);
      pending.resolve(c.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "User denied this request" });
      this.state(c.chatId, run.pending.size ? "waiting" : "running");
    }
    return { ...this.status(), chat: this.read(c.chatId) };
  }
  private async permission(id: string, run: Running, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    if (signal.aborted || run.abort.signal.aborted || this.disposed) return { behavior: "deny", message: "Turn cancelled" };
    const display = JSON.stringify(input);
    if (display.length > 30000) return { behavior: "deny", message: "Tool input exceeds the review limit; split it into smaller calls" };
    if (this.redact(display) !== display) return { behavior: "deny", message: "Tool input contains a runtime credential; remove it before retrying" };
    const request: EmbeddedRequest = { id: randomUUID(), tool, input: this.redact(display) };
    if (tool === "AskUserQuestion") {
      const parsed = questionsSchema.safeParse(input.questions);
      if (!parsed.success) return { behavior: "deny", message: "Unsupported question format. Ask in the conversation instead." };
      request.questions = parsed.data;
    }
    return new Promise(resolve => {
      const finish = (value: PermissionResult) => {
        signal.removeEventListener("abort", aborted);
        run.abort.signal.removeEventListener("abort", aborted);
        run.pending.delete(request.id);
        resolve(value);
        if (!this.disposed && this.runs.get(id) === run) this.state(id, run.pending.size ? "waiting" : "running");
      };
      const aborted = () => finish({ behavior: "deny", message: "Request cancelled" });
      run.pending.set(request.id, { request, input, resolve: finish });
      signal.addEventListener("abort", aborted, { once: true });
      run.abort.signal.addEventListener("abort", aborted, { once: true });
      this.state(id, "waiting");
    });
  }
  private async execute(id: string, text: string, run: Running): Promise<void> {
    let success = false, finished = false;
    const blocks = new Map<string, string>();
    const textKeys = new Map<string, string[]>();
    const completedFrames = new Set<string>();
    const registerText = (message: string, index: number) => {
      const key = `${message}:${index}`;
      if (!blocks.has(key)) {
        blocks.set(key, "");
        textKeys.set(message, [...(textKeys.get(message) ?? []), key]);
      }
      return key;
    };
    let messageId = randomUUID() as string;
    try {
      const session = this.require(id), config = join(this.root, "embedded-sdk");
      mkdirSync(config, { recursive: true, mode: 0o700 });
      const env = { ...this.config.env };
      if (this.config.authMode !== "claude-code") env.CLAUDE_CONFIG_DIR = config;
      const options: Options = {
        cwd: session.cwd, env, model: this.config.model, settingSources: [], strictMcpConfig: true, mcpServers: {}, permissionMode: "default", persistSession: true,
        includePartialMessages: true, resume: session.sessionId ?? undefined, abortController: run.abort,
        tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "AskUserQuestion"],
        hooks: { PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Embedded experiment requires approval for every tool call" } })] }] },
        canUseTool: (tool, input, context) => this.permission(id, run, tool, input, context.signal),
        onElicitation: async () => { this.event(id, randomUUID(), "notice", "MCP input is unsupported in this experiment; request declined."); return { action: "decline" }; },
      };
      run.query = await startedQuery(this.runner(text, options), run.abort.signal);
      if (run.abort.signal.aborted) return;
      const iterator = run.query[Symbol.asyncIterator]();
      while (true) {
        const next = await nextMessage(iterator, run.abort.signal);
        if (next.done) break;
        const message = next.value;
        if (run.abort.signal.aborted || this.disposed) break;
        if ("session_id" in message && message.session_id) this.store.db.prepare("UPDATE embedded_sessions SET sessionId=? WHERE chatId=?").run(message.session_id, id);
        if (message.type === "stream_event" && !message.parent_tool_use_id) {
          const event = message.event;
          if (event.type === "message_start") messageId = event.message.id;
          if (event.type === "content_block_start" && event.content_block.type === "text") registerText(messageId, event.index);
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            const key = registerText(messageId, event.index);
            const content = cap((blocks.get(key) ?? "") + event.delta.text);
            blocks.set(key, content);
            if (blocks.size > 500) blocks.delete(blocks.keys().next().value!);
            this.event(id, key, "assistant", content);
          }
        }
        if (message.type === "assistant" && message.error) {
          this.event(id, randomUUID(), "error", connectionDiagnostic(message.error));
          continue;
        }
        if (message.type === "assistant" && !message.parent_tool_use_id && !completedFrames.has(message.uuid)) {
          completedFrames.add(message.uuid);
          for (const [index, block] of message.message.content.entries()) {
            if (block.type === "text") {
              // SDK 0.3.302 emits one completed block per assistant envelope;
              // array position is not its original streaming content-block index.
              const queue = textKeys.get(message.message.id);
              const key = queue?.shift() ?? `${message.uuid ?? randomUUID()}:text:${index}`;
              this.event(id, key, "assistant", block.text);
            }
            if (block.type === "tool_use") this.event(id, block.id, "tool", `${block.name}\n${cap(block.input)}`);
          }
        }
        if (message.type === "user" && Array.isArray(message.message.content)) {
          for (const block of message.message.content) if (block.type === "tool_result") this.event(id, `${block.tool_use_id}:result`, "tool", `${block.is_error ? "Tool error" : "Tool result"}\n${cap(block.content)}`);
        }
        if (message.type === "result") {
          finished = true;
          success = !message.is_error;
          this.event(id, randomUUID(), success ? "notice" : "error", success ? "Turn complete" : connectionDiagnostic("errors" in message ? message.errors.join(" ") : ""));
          break;
        }
      }
      if (!finished && !run.abort.signal.aborted) this.event(id, randomUUID(), "error", "Turn ended without a successful result. Send a follow-up to retry/resume.");
    } catch (error) {
      if (!run.abort.signal.aborted && !this.disposed) {
        // Subprocess error strings can contain credentials or environment values.
        this.event(id, randomUUID(), "error", connectionDiagnostic(error));
      }
    } finally {
      for (const pending of [...run.pending.values()]) pending.resolve({ behavior: "deny", message: "Turn ended" });
      try { run.query?.close(); } catch { /* Abort already requested; still release Deck lifecycle. */ }
      if (this.runs.get(id) !== run) return;
      this.runs.delete(id);
      if (!this.disposed) {
        if (run.abort.signal.aborted) this.event(id, randomUUID(), "notice", "Turn cancelled. Tool side effects already completed are retained.");
        this.state(id, success || run.abort.signal.aborted ? "idle" : "error");
      }
    }
  }
  private cancel(id: string): void {
    const run = this.runs.get(id);
    if (run) { run.abort.abort(); try { run.query?.close(); } catch { /* Execute finally releases state. */ } }
  }
  close(): void {
    this.disposed = true;
    for (const id of this.runs.keys()) this.cancel(id);
  }
}
