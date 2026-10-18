// Test-only SDK fault injection. Never imports the live runner or calls a provider.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Store } from "../src/main/store";
import { PlanningStore } from "../src/main/planning-store";
import { EmbeddedChats } from "../src/main/embedded-chat";
import { embeddedConfig } from "../src/main/embedded-config";
import type { AgentQuery, AgentRunner } from "../src/main/embedded-sdk";
import type { EmbeddedChat } from "../src/shared/embedded-chat";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Changes {
  version = 0;
  private waiters = new Set<() => void>();
  notify = () => { this.version++; for (const wake of this.waiters) wake(); this.waiters.clear(); };
  after(version: number) {
    if (version !== this.version) return Promise.resolve();
    return new Promise<void>(resolve => this.waiters.add(resolve));
  }
}
export const sdk = (value: unknown) => value as SDKMessage;
export const success = (session_id = "11111111-1111-4111-8111-111111111111") => sdk({ type: "result", subtype: "success", is_error: false, session_id });

// A parked next() models an unresponsive SDK, not a claimed provider event.
export class ControlledQuery implements AgentQuery {
  closed = 0;
  private pending?: ReturnType<typeof deferred<IteratorResult<SDKMessage>>>;
  private buffered: IteratorResult<SDKMessage>[] = [];
  private reads = new Changes();
  close() { this.closed++; }
  [Symbol.asyncIterator]() { return { next: () => {
    const queued = this.buffered.shift();
    if (queued) return Promise.resolve(queued);
    this.pending = deferred<IteratorResult<SDKMessage>>();
    this.reads.notify();
    return this.pending.promise;
  } }; }
  emit(message: SDKMessage) { this.deliver({ done: false, value: message }); }
  end() { this.deliver({ done: true, value: undefined }); }
  private deliver(value: IteratorResult<SDKMessage>) {
    if (this.pending) { const pending = this.pending; this.pending = undefined; pending.resolve(value); }
    else this.buffered.push(value);
  }
  async parked() {
    while (!this.pending) { const version = this.reads.version; if (!this.pending) await this.reads.after(version); }
  }
}

export function faultFixture(t: TestContext, runner: AgentRunner) {
  const dir = mkdtempSync(join(tmpdir(), "acd-embedded-fault-")), changes = new Changes();
  const database = join(dir, "workspace.sqlite"), ledger = join(dir, "effects.txt");
  const config = embeddedConfig({ ACD_EMBEDDED_AUTH: "api-key", ANTHROPIC_API_KEY: "synthetic-fault-key" });
  let store = new Store(database), service = new EmbeddedChats(store, dir, changes.notify, true, runner, config);
  store.command({ type: "createPlanItem", day: "2026-10-18", category: "Other", name: "Synthetic fault task" });
  const taskId = new PlanningStore(store).items()[0].id;
  t.after(async () => {
    service.close();
    // Drain cancellation cleanup before disposing SQLite. This is an event-loop
    // barrier, not a timing assumption about the SDK or a graceful-crash test.
    await new Promise<void>(resolve => setImmediate(resolve));
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const read = async (chatId: string) => (await service.command({ type: "read", chatId })).chat!;
  return {
    dir, taskId, get store() { return store; }, get service() { return service; }, read,
    async create(task = taskId) { return (await service.command({ type: "create", taskId: task, cwd: dir, name: "Synthetic fault chat" })).chat!; },
    send(chatId: string, text = "Synthetic", sendId = randomUUID()) { return service.command({ type: "send", chatId, text, sendId }); },
    async wait(chatId: string, predicate: (chat: EmbeddedChat) => boolean) {
      while (true) {
        const version = changes.version, chat = await read(chatId);
        if (predicate(chat)) return chat;
        await changes.after(version);
      }
    },
    async reopen() {
      service.close(); await new Promise<void>(resolve => setImmediate(resolve)); store.close();
      store = new Store(database); service = new EmbeddedChats(store, dir, changes.notify, true, runner, config);
    },
    commitEffect(label: string) { appendFileSync(ledger, `${label}\n`, { flush: true }); },
    effects() { return existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n") : []; },
  };
}
