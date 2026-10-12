import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store";
import type { MatchingMeasurement, MatchingAnalyticsSummary } from "../shared/matching-analytics";

const number = z.number().finite().nonnegative(), score = z.number().finite().min(0).max(1);
const measurementSchema = z.object({
  backend: z.enum(["local", "openrouter", "bedrock"]), model: z.string().regex(/^[\w./:-]{1,200}$/),
  revision: z.string().regex(/^[\w./:-]{1,200}$/), adapter: z.string().regex(/^[\w.-]{1,100}$/),
  policy: z.object({ likelihood: score, margin: score, context: score.nullable() }).strict(), threads: z.number().int().min(1).max(8).nullable(),
  outcome: z.enum(["linked", "not-applied", "no_match", "uncertain", "insufficient_context", "stale", "cancelled", "error"]),
  inferenceMs: number.nullable(), cold: z.boolean(), endToEndMs: number, waitMs: number, cpuMs: number.nullable(), peakRssBytes: number.nullable(),
  candidateCount: z.number().int().min(0).max(50), inputChars: z.number().int().min(0).max(512*1024), truncated: z.boolean(),
  contextScore: score.nullable(), topScore: score.nullable(), margin: score.nullable(),
}).strict();
type Cached = { days: number; until: number; value: MatchingAnalyticsSummary };
const caches = new WeakMap<Store, Cached>();
const incomplete = new WeakSet<Store>();
export function analyticsIncomplete(store: Store) { incomplete.add(store); caches.delete(store); }
export class MatchingAnalytics {
  constructor(private store: Store) {}
  private retain() {
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    for (const table of ["matching_measurements", "matching_feedback"]) {
      this.store.db.prepare(`DELETE FROM ${table} WHERE at < ?`).run(cutoff);
      this.store.db.prepare(`DELETE FROM ${table} WHERE rowid NOT IN (SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT 10000)`).run();
    }
    caches.delete(this.store);
  }
  record(chatId: string, value: MatchingMeasurement): void {
    const data = measurementSchema.parse(value);
    this.store.db.prepare("INSERT INTO matching_measurements VALUES (?,?,?,?)").run(randomUUID(), chatId, new Date().toISOString(), JSON.stringify(data));
    this.retain();
  }
  feedback(chatId: string, itemId: string, kind: "removed" | "manually-linked" | "undo-restored") {
    this.store.db.prepare("INSERT INTO matching_feedback VALUES (?,?,?,?,?)").run(randomUUID(), chatId, itemId, new Date().toISOString(), kind);
    this.retain();
  }
  clear() {
    this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM matching_measurements").run();
      this.store.db.prepare("DELETE FROM matching_feedback").run();
    })();
    caches.delete(this.store);
    incomplete.delete(this.store);
  }
  summary(days = 7): MatchingAnalyticsSummary {
    if (![1,7,30].includes(days)) throw new Error("Invalid analytics range");
    const cached = caches.get(this.store);
    if (cached?.days === days && cached.until > Date.now()) return cached.value;
    this.retain();
    const cutoff = new Date(Date.now()-days*86400_000).toISOString();
    const rows = (this.store.db.prepare("SELECT * FROM matching_measurements WHERE at >= ? ORDER BY rowid").all(cutoff) as
      { id: string; chatId: string; at: string; data: string }[]).flatMap(row => {
        try { return [{...row,data:measurementSchema.parse(JSON.parse(row.data))}]; }
        catch { analyticsIncomplete(this.store); return []; }
      });
    const percentile = (values: (number | null)[], p: number) => {
      const sorted = values.filter((v): v is number => v !== null).sort((a,b)=>a-b);
      return sorted.length ? sorted[Math.min(sorted.length-1, Math.ceil(sorted.length*p)-1)] : null;
    };
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const d = row.data, key = JSON.stringify([d.backend,d.model,d.revision,d.adapter,d.policy,d.threads]);
      const group = grouped.get(key) ?? []; group.push(row); grouped.set(key,group);
    }
    const outcomes: Record<string,number> = {};
    for (const row of rows) outcomes[row.data.outcome] = (outcomes[row.data.outcome] ?? 0)+1;
    const feedback = this.store.db.prepare("SELECT kind,COUNT(*) AS n FROM matching_feedback WHERE at >= ? GROUP BY kind").all(cutoff) as {kind:string;n:number}[];
    const count = (kind: string) => feedback.find(f=>f.kind===kind)?.n ?? 0;
    const value: MatchingAnalyticsSummary = { days, assessments: rows.length, collectionIncomplete:incomplete.has(this.store), chats: new Set(rows.map(r=>r.chatId)).size, outcomes,
      feedback: { removed: count("removed"), manuallyLinked: count("manually-linked"), undoRestored: count("undo-restored") },
      configurations: [...grouped.entries()].map(([key,group]) => {
        const d=group[0].data, success=group.filter(r=>!["error","cancelled"].includes(r.data.outcome)), warm=success.filter(r=>!r.data.cold);
        return { identity: createHash("sha256").update(key).digest("hex"), backend:d.backend, model:d.model, revision:d.revision, adapter:d.adapter, threads:d.threads, policy:d.policy,
          samples:group.length, warmSamples:warm.filter(r=>r.data.inferenceMs!==null).length,
          inferenceP50Ms:percentile(warm.map(r=>r.data.inferenceMs),.5), inferenceP95Ms:percentile(warm.map(r=>r.data.inferenceMs),.95),
          endToEndP95Ms:percentile(success.map(r=>r.data.endToEndMs),.95), waitP95Ms:percentile(success.map(r=>r.data.waitMs),.95),
          peakRssBytes:percentile(group.map(r=>r.data.peakRssBytes),1),
          cpuMs:group.some(r=>r.data.cpuMs!==null)?group.reduce((sum,r)=>sum+(r.data.cpuMs??0),0):null };
      }), quality: { reviewed:0, precision:null, recall:null },
      recent:rows.slice(-20).reverse().map(r=>({ id:r.id,at:r.at,model:r.data.model,outcome:r.data.outcome,inferenceMs:r.data.inferenceMs,endToEndMs:r.data.endToEndMs })) };
    caches.set(this.store,{days,until:Date.now()+60_000,value});
    return value;
  }
  export(days = 7): string {
    const { recent: _recent, ...summary } = this.summary(days);
    return JSON.stringify({ schema_version:"local_matching_summary.v1", provenance:"local-usage", platform:process.platform, architecture:process.arch,
      ...summary, notes:["Contains aggregate metrics only; no chat/task IDs or content.","Removed links are feedback, not confirmed errors. No explicit quality reviews exist in this MVP.","End-to-end includes queue, cold load where applicable and application. Model percentiles exclude each worker's first request; no separate synthetic warmup."] }, null, 2);
  }
}
