import { join } from "node:path";
import type { Snapshot } from "../shared/types";
import { commandSchema } from "../shared/validation";
import { Store } from "./store";
import { Inbox } from "./inbox";
import { PlanningStore } from "./planning-store";
import { readPlanInbox } from "./plan-inbox";
import { sourceSetup, writeHookSetup, type HookConnection } from "./setup";
import { HookReceiver } from "./http";
import { advanceDemo, seedDemo } from "./demo";

// Shared by the desktop shell and window-free renderer integration tests.
// Electron alone owns IPC trust, clipboard, external links and OS decoration.
export class WorkspaceRuntime {
  store!: Store;
  private inbox!: Inbox;
  private connection!: HookConnection;
  private readonly receiver: HookReceiver;
  private timer?: NodeJS.Timeout;
  private ingestionError: string | null = null;
  private planInboxSignature = "";

  constructor(
    private readonly base: string,
    private readonly changed: () => void,
    private demo = false,
  ) {
    this.receiver = new HookReceiver(() => ({
      store: this.store, inbox: this.inbox, root: this.root(), demo: this.demo,
    }));
  }

  private root(): string {
    return join(this.base, this.demo ? "demo" : "workspace");
  }

  async start(): Promise<void> {
    try {
      this.connection = await this.receiver.listen();
      this.openStore();
      this.timer = setInterval(() => this.pollInbox(), 1000);
      this.pollInbox();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.receiver.server.close();
    this.receiver.server.closeAllConnections();
    this.store?.close();
  }

  private openStore(): void {
    this.store = new Store(join(this.root(), "workspace.sqlite"));
    if (this.demo) seedDemo(this.store);
    for (const source of this.store.sources()) {
      try {
        writeHookSetup(this.root(), source, this.connection);
      } catch {
        this.store.sourceError(
          source.id,
          "Could not create HTTP hook configuration. Check directory permissions.",
        );
      }
    }
    this.inbox = new Inbox(this.store, this.root(), this.changed);
  }

  private pollInbox(): void {
    const before = this.ingestionError;
    try {
      this.inbox.poll();
      this.ingestionError = null;
    } catch {
      this.ingestionError = "Event ingestion is paused by a storage error. Check disk space and permissions; queued events will be retried.";
    }
    if (before !== this.ingestionError) this.changed();
    const signature = JSON.stringify(readPlanInbox(this.root(), new PlanningStore(this.store)));
    if (signature !== this.planInboxSignature) {
      this.planInboxSignature = signature;
      this.changed();
    }
  }

  snapshot(): Snapshot {
    const sources = this.store.sources();
    const plans = new PlanningStore(this.store);
    return {
      planning: {
        items: plans.items(),
        entries: plans.entries(),
        imports: plans.imports(),
        inbox: readPlanInbox(this.root(), plans),
      },
      settings: this.store.settings(),
      links: this.store.links(),
      projects: this.store.projects(),
      chats: this.store.chats(),
      sources,
      workspaces: this.store.workspaces(),
      demo: this.demo,
      dataDirectory: this.root(),
      ingestionError: this.ingestionError,
      setups: Object.fromEntries(
        sources.map(s => [s.id, sourceSetup(this.root(), s, process.platform, this.connection)]),
      ),
    };
  }

  command(input: unknown): Snapshot {
    const command = commandSchema.parse(input);
    if (command.type === "setDemo") {
      if (command.enabled !== this.demo) {
        const previous = this.demo;
        this.store.close();
        this.demo = command.enabled;
        try {
          this.openStore();
        } catch (error) {
          this.demo = previous;
          this.openStore();
          throw error;
        }
      }
    } else if (command.type === "advanceDemo") {
      if (!this.demo)
        throw new Error("Sample transitions are available only in demo mode");
      advanceDemo(this.store);
    } else if (command.type === "testSource") {
      this.inbox.test(command.id);
    } else {
      const previous = new Set(this.store.sources().map(s => s.id));
      this.store.command(command);
      if (command.type === "createSource") {
        for (const source of this.store.sources().filter(s => !previous.has(s.id))) {
          try {
            writeHookSetup(this.root(), source, this.connection);
          } catch {
            this.store.sourceError(
              source.id,
              "HTTP hook setup failed. Restart the app after checking directory permissions.",
            );
          }
        }
      }
    }
    this.changed();
    return this.snapshot();
  }
}
