import { z } from "zod";
import type { Store } from "./store";
import type { LocalFailureKind } from "./local-matching-error";
import { analyticsIncomplete } from "./matching-analytics";

const KEY = "localMatchingRetries";
const DELAYS = [15_000, 60_000];
const schema = z.object({
  identity: z.string().max(100), workerFailures: z.number().int().min(0).max(3), workerReadyAt: z.number().finite().nonnegative(),
  entries: z.array(z.object({ chatId: z.string().min(1).max(200), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    failures: z.number().int().min(1).max(2), readyAt: z.number().finite().nonnegative() }).strict()).max(64),
}).strict();
export class MatchingRetries {
  private state = schema.parse({ identity:"", workerFailures:0, workerReadyAt:0, entries:[] });
  constructor(private store: Store, private clock: () => number) {
    const row = store.db.prepare("SELECT value FROM settings WHERE key=?").get(KEY) as {value:string} | undefined;
    if (row) { try { this.state = schema.parse(JSON.parse(row.value)); } catch { /* Ignore unusable bounded state. */ } }
  }
  private save() {
    try {
      this.store.db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(KEY,JSON.stringify(this.state));
    } catch { analyticsIncomplete(this.store); }
  }
  configure(identity: string) {
    if (this.state.identity === identity) return;
    this.state = {identity,workerFailures:0,workerReadyAt:0,entries:[]}; this.save();
  }
  workerReady() { return this.state.workerFailures < 3 && this.clock() >= this.state.workerReadyAt; }
  allows(chatId: string, fingerprint: string) {
    const entry = this.state.entries.find(e=>e.chatId===chatId);
    return entry ? entry.fingerprint !== fingerprint || this.clock() >= entry.readyAt : this.state.entries.length < 64;
  }
  prune(active: Set<string>) {
    const entries = this.state.entries.filter(e=>active.has(e.chatId));
    if (entries.length !== this.state.entries.length) { this.state.entries=entries; this.save(); }
  }
  succeeded(chatId?: string) {
    const entries = chatId ? this.state.entries.filter(e=>e.chatId!==chatId) : this.state.entries;
    if (entries.length === this.state.entries.length && !this.state.workerFailures) return;
    this.state = {...this.state,entries,workerFailures:0,workerReadyAt:0}; this.save();
  }
  // Returns true once this fingerprint should be cached as finished (without a link).
  failed(chatId: string, fingerprint: string, kind: LocalFailureKind): boolean {
    const previous = this.state.entries.find(e=>e.chatId===chatId && e.fingerprint===fingerprint);
    const failures = (previous?.failures ?? 0)+1;
    const permanent = ["input","invalid-output","unavailable"].includes(kind);
    this.state.entries = this.state.entries.filter(e=>e.chatId!==chatId);
    if (kind === "worker" || kind === "timeout") {
      this.state.workerFailures = Math.min(3,this.state.workerFailures+1);
      this.state.workerReadyAt = this.clock() + (DELAYS[this.state.workerFailures-1] ?? 0);
    }
    const done = permanent || failures >= 3 || this.state.entries.length >= 64;
    if (!done) this.state.entries.push({chatId,fingerprint,failures,readyAt:this.clock()+DELAYS[failures-1]});
    this.save(); return done;
  }
}
