import { createHash } from "node:crypto";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROMPT_VERSION, THRESHOLDS, decide, prepareInput, requestMatch, type MatchPayload } from "../shared/chat-matching";
import { matchingConfigSchema, type MatchingConfig, type MatchingStatus } from "../shared/matching-settings";
import { localPlanDay } from "../shared/planning";
import type { Store } from "./store";
import { PlanningStore } from "./planning-store";
import type { SecretStore } from "./secret-store";

const defaults = matchingConfigSchema.parse({ enabled: false, model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER });
export class ChatMatcher {
  private config: MatchingConfig;
  private error: string | null = null;
  private busy = false;
  private updating = false;
  private disposed = false;
  private generation = 0;
  private nextRequestAt = 0;
  private controller: AbortController | null = null;
  private lastCheckedAt: string | null;
  constructor(private store: Store, private secrets: Record<"openrouter" | "bedrock", SecretStore>, private changed: () => void,
    private demo = false, private request: typeof requestMatch = requestMatch,
    private clock: () => number = Date.now) {
    const row = store.db.prepare("SELECT value FROM settings WHERE key='chatMatching'").get() as { value: string } | undefined;
    this.config = { ...defaults };
    if (row) {
      try { this.config = matchingConfigSchema.parse(JSON.parse(row.value)); }
      catch { this.error = "Chat matching settings could not be read. Save them again in Settings."; }
    }
    this.lastCheckedAt = (store.db.prepare("SELECT MAX(checkedAt) AS time FROM ai_match_attempts").get() as { time: string | null }).time;
    const cooldown = store.db.prepare("SELECT value FROM settings WHERE key='chatMatchingNextRequestAt'").get() as { value: string } | undefined;
    const nextAt = Number(cooldown?.value ?? 0);
    this.nextRequestAt = Number.isFinite(nextAt) ? Math.min(nextAt, this.clock() + 12_000) : 0;
  }
  private secret(config = this.config): SecretStore { return this.secrets[config.backend]; }
  private requestOptions() {
    return { backend: this.config.backend, region: this.config.bedrockRegion,
      model: this.config.backend === "bedrock" ? this.config.bedrockModel : this.config.model, provider: this.config.provider };
  }
  status(): MatchingStatus {
    return { config: { ...this.config }, keyStored: this.secret().hasKey(), secureStorageAvailable: this.secret().available(),
      running: this.busy, error: this.error, lastCheckedAt: this.lastCheckedAt, demo: this.demo };
  }
  private cancel(): void { this.generation++; this.controller?.abort(); }
  dispose(): void { this.disposed = true; this.cancel(); }
  async save(config: MatchingConfig, apiKey?: string): Promise<void> {
    if (this.updating) throw new Error("Wait for the current settings save to finish.");
    const next = matchingConfigSchema.parse(config);
    if (next.enabled && (!this.secret(next).available() || (!apiKey && !this.secret(next).hasKey())))
      throw new Error("Save an API key using secure storage before enabling automatic links.");
    this.cancel();
    this.updating = true;
    try {
      if (apiKey) await this.secret(next).save(apiKey);
      if (this.disposed) throw new Error("The workspace changed during the settings save.");
      this.store.db.prepare("INSERT INTO settings (key,value) VALUES ('chatMatching',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
      this.config = next; this.error = null;
    } finally { this.updating = false; }
  }
  async removeKey(): Promise<void> {
    await this.save({ ...this.config, enabled: false });
    this.secret().remove();
  }
  private context() {
    const plans = new PlanningStore(this.store), day = localPlanDay(new Date(this.clock()));
    return { day, chats: this.store.chats(), items: plans.items(), entries: plans.entries().filter(entry => entry.day === day),
      sources: this.store.sources(), projects: this.store.projects(),
      dismissals: this.store.db.prepare("SELECT itemId,chatId FROM ai_link_dismissals").all() as { itemId: string; chatId: string }[] };
  }
  private job(chatId: string, context = this.context()): { payload: MatchPayload; fingerprint: string } | null {
    const { day, items, entries } = context;
    const chat = context.chats.find(chat => chat.id === chatId);
    if (!chat || chat.archived || chat.provider === "manual" || !chat.latestRound ||
        (!chat.latestRound.prompt.trim() && !chat.latestRound.response.trim()) ||
        localPlanDay(new Date(chat.lastEventAt ?? chat.createdAt)) !== day) return null;
    if (chat.sourceId && !context.sources.some(source => source.id === chat.sourceId && source.enabled)) return null;
    const linked = items.filter(item => item.chatIds.includes(chatId));
    if (linked.length) return null;
    if (entries.length > 50) throw new Error("Automatic matching supports up to 50 tasks on today's card. No request was sent.");
    const dismissed = context.dismissals.filter(row => row.chatId === chatId);
    const repo = context.projects.find(project => project.id === chat.repoProjectId);
    const round = chat.latestRound;
    const prepared = prepareInput({
      schema_version: PROMPT_VERSION, plan_day: day,
      tasks: entries.map(entry => {
        const item = items.find(item => item.id === entry.itemId)!;
        return { id: item.id, title: entry.name || item.name, notes: item.notes.slice(0, 2000), day_note: entry.note.slice(0, 2000), ticket_keys: item.tickets.slice(0, 30).map(ticket => ticket.key.slice(0, 100)) };
      }),
      chat: { id: chat.id, title: (chat.name || chat.providerTitle).slice(0, 500), repository: repo?.name.slice(0, 500) ?? null,
        latest_round: { prompt: round.prompt.slice(0, 6000), response: round.response.slice(0, 6000), truncated: round.truncated || round.prompt.length > 6000 || round.response.length > 6000 } },
    }, { existing_links: linked.map(item => ({ task_id: item.id, origin: item.automaticChatIds?.includes(chatId) ? "ai" : "manual" })), dismissed_task_ids: dismissed.map(row => row.itemId) });
    if (prepared.skip) return null;
    return { payload: prepared.payload, fingerprint: createHash("sha256").update(JSON.stringify({ payload: prepared.payload, connection: this.requestOptions(), thresholds: THRESHOLDS })).digest("hex") };
  }
  async tick(): Promise<void> {
    if (this.disposed || this.demo || this.busy || this.updating || this.error || !this.config.enabled ||
        !this.secret().hasKey() || !this.secret().available() || this.clock() < this.nextRequestAt) return;
    let candidate: ReturnType<ChatMatcher["job"]> = null;
    try {
      const context = this.context();
      for (const chat of context.chats) {
        const job = this.job(chat.id, context);
        if (!job) continue;
        const previous = this.store.db.prepare("SELECT fingerprint FROM ai_match_attempts WHERE chatId=?").get(chat.id) as { fingerprint: string } | undefined;
        if (previous?.fingerprint !== job.fingerprint) { candidate = job; break; }
      }
    } catch (error) {
      this.error = error instanceof Error && error.message.startsWith("Automatic matching supports") ? error.message : "Could not prepare today's chats for matching. Check the card and restart or save AI settings again.";
      this.changed(); return;
    }
    if (!candidate) return;
    const generation = this.generation, job = candidate;
    this.busy = true; this.controller = new AbortController();
    this.changed();
    try {
      const apiKey = await this.secret().read();
      if (this.disposed || generation !== this.generation) return;
      this.nextRequestAt = this.clock() + 12_000;
      this.store.db.prepare("INSERT INTO settings (key,value) VALUES ('chatMatchingNextRequestAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.nextRequestAt));
      const { output } = await this.request(job.payload, { apiKey, ...this.requestOptions(), signal: this.controller!.signal });
      if (this.disposed || generation !== this.generation || !this.config.enabled) return;
      // Rebuild from current storage; never apply a response against stale user edits.
      const current = this.job(job.payload.chat.id);
      if (current?.fingerprint !== job.fingerprint) return;
      const decision = decide(output), checkedAt = new Date(this.clock()).toISOString();
      this.store.db.transaction(() => {
        if (decision.task_id) new PlanningStore(this.store).linkAutomatically(decision.task_id, job.payload.chat.id);
        this.store.db.prepare("INSERT INTO ai_match_attempts (chatId,fingerprint,checkedAt) VALUES (?,?,?) ON CONFLICT(chatId) DO UPDATE SET fingerprint=excluded.fingerprint,checkedAt=excluded.checkedAt").run(job.payload.chat.id, job.fingerprint, checkedAt);
      })();
      this.lastCheckedAt = checkedAt;
    } catch (error) {
      if (!this.disposed && generation === this.generation)
        this.error = error instanceof Error ? error.message : "Chat matching failed. Save AI settings to retry.";
    } finally {
      this.busy = false; this.controller = null;
      if (!this.disposed) this.changed();
    }
  }
  async testConnection(): Promise<void> {
    if (this.busy || this.updating) throw new Error("Wait for the current request or settings save to finish.");
    const generation = this.generation;
    this.busy = true; this.controller = new AbortController(); this.changed();
    try {
      const apiKey = await this.secret().read();
      if (this.disposed || generation !== this.generation) throw new Error("Connection settings changed during the test.");
      await this.request({ schema_version: PROMPT_VERSION, plan_day: localPlanDay(),
        tasks: [{ id: "connection-test", title: "Connection test", notes: "Verify matching with a synthetic example", day_note: "", ticket_keys: [] }],
        chat: { id: "connection-test", title: "Connection test", repository: null, latest_round: { prompt: "Verify matching with a synthetic example.", response: "", truncated: false } },
      }, { apiKey, ...this.requestOptions(), signal: this.controller!.signal, syntheticDiagnostics: true });
      if (this.disposed || generation !== this.generation) throw new Error("Connection settings changed during the test.");
      this.error = null;
    } finally { this.busy = false; this.controller = null; if (!this.disposed) this.changed(); }
  }
}
