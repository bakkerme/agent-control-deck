import { join } from "node:path";
import type { Snapshot } from "../shared/types";
import { commandSchema, idSchema, ticketUrl } from "../shared/validation";
import { z } from "zod";
import { resolveTicketUrl } from "../shared/tickets";
import { Store } from "./store";
import { Inbox } from "./inbox";
import { PlanningStore } from "./planning-store";
import { sourceSetup, writeHookSetup, type HookConnection } from "./setup";
import { HookReceiver } from "./http";
import { advanceDemo, seedDemo } from "./demo";
import { ChatMatcher } from "./chat-matcher";
import { SecretStore, type SecretEncryption } from "./secret-store";
import { saveMatchingSchema } from "../shared/matching-settings";

const unavailableEncryption: SecretEncryption = {
  available: () => false,
  encrypt: () => { throw new Error("Encryption unavailable"); },
  decrypt: () => { throw new Error("Encryption unavailable"); },
};

// Shared by the desktop shell and window-free renderer integration tests.
// Electron alone owns IPC trust, clipboard, external links and OS decoration.
export class WorkspaceRuntime {
  store!: Store;
  private inbox!: Inbox;
  private connection!: HookConnection;
  private readonly receiver: HookReceiver;
  private timer?: NodeJS.Timeout;
  private ingestionError: string | null = null;
  private matcher!: ChatMatcher;

  constructor(
    private readonly base: string,
    private readonly changed: () => void,
    private demo = false,
    private readonly encryption: SecretEncryption = unavailableEncryption,
  ) {
    this.receiver = new HookReceiver(() => ({
      store: this.store,
      inbox: this.inbox,
      root: this.root(),
      demo: this.demo,
    }));
  }

  private root(): string {
    return join(this.base, this.demo ? "demo" : "workspace");
  }

  async start(): Promise<void> {
    try {
      this.connection = await this.receiver.listen();
      this.openStore();
      this.timer = setInterval(() => {
        this.pollInbox();
        void this.matcher.tick().catch(() => { /* Matching must never stop ingestion. */ });
      }, 1000);
      this.pollInbox();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    this.matcher?.dispose();
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
    this.matcher = new ChatMatcher(this.store, {
      openrouter: new SecretStore(join(this.root(), "openrouter-key.enc"), this.encryption),
      bedrock: new SecretStore(join(this.root(), "bedrock-key.enc"), this.encryption),
    }, this.changed, this.demo);
  }

  private pollInbox(): void {
    const before = this.ingestionError;
    try {
      this.inbox.poll();
      this.ingestionError = null;
    } catch {
      this.ingestionError =
        "Event ingestion is paused by a storage error. Check disk space and permissions; queued events will be retried.";
    }
    if (before !== this.ingestionError) this.changed();
  }

  snapshot(): Snapshot {
    const sources = this.store.sources();
    const plans = new PlanningStore(this.store);
    return {
      matching: this.matcher.status(),
      planning: {
        items: plans.items(),
        entries: plans.entries(),
        imports: plans.imports(),
        inbox: { path: "", files: [], error: null },
        wrapups: plans.wrapups(),
        drafts: plans.drafts(),
        undoId: plans.undoId(),
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
        sources.map((s) => [
          s.id,
          sourceSetup(this.root(), s, process.platform, this.connection),
        ]),
      ),
    };
  }

  async saveMatching(input: unknown): Promise<void> {
    const { config, apiKey } = saveMatchingSchema.parse(input);
    await this.matcher.save(config, apiKey);
    this.changed();
  }

  async removeMatchingKey(input: unknown): Promise<void> {
    z.undefined().parse(input);
    await this.matcher.removeKey();
    this.changed();
  }

  async testMatchingConnection(input: unknown): Promise<void> {
    z.undefined().parse(input);
    await this.matcher.testConnection();
  }

  planLinkUrl(input: unknown): string {
    const { itemId, url } = z
      .object({ itemId: idSchema, url: ticketUrl.refine((value) => !!value) })
      .strict()
      .parse(input);
    const item = new PlanningStore(this.store)
      .items()
      .find((item) => item.id === itemId);
    if (
      !item ||
      item.hiddenLinks.includes(url) ||
      (!item.links.some((link) => link.url === url) &&
        !this.store
          .links()
          .some(
            (link) => item.chatIds.includes(link.chatId) && link.url === url,
          ))
    )
      throw new Error("This URL is no longer linked to the task");
    return ticketUrl.parse(url);
  }

  planTicketUrl(input: unknown): string | null {
    const { itemId, key } = z
      .object({ itemId: idSchema, key: z.string().max(2000) })
      .strict()
      .parse(input);
    const item = new PlanningStore(this.store)
      .items()
      .find((item) => item.id === itemId);
    if (!item?.tickets.some((ticket) => ticket.key === key))
      throw new Error("This ticket is no longer linked to the task");
    return /^https?:\/\//i.test(key)
      ? ticketUrl.parse(key)
      : resolveTicketUrl({ jiraKey: key, jiraUrl: "" }, this.store.settings());
  }

  command(input: unknown): Snapshot {
    const command = commandSchema.parse(input);
    if (command.type === "setDemo") {
      if (command.enabled !== this.demo) {
        const previous = this.demo;
        this.matcher.dispose();
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
      const previous = new Set(this.store.sources().map((s) => s.id));
      this.store.command(command);
      if (command.type === "createSource") {
        for (const source of this.store
          .sources()
          .filter((s) => !previous.has(s.id))) {
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
