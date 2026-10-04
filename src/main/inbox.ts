import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store";
import { envelopeSchema } from "../shared/validation";

export class Inbox {
  constructor(
    private store: Store,
    private root: string,
    private changed: () => void,
  ) {}
  enqueue(sourceId: string, raw: unknown): void {
    this.store.source(sourceId);
    const envelope = envelopeSchema.parse(raw);
    const body = JSON.stringify(envelope);
    if (Buffer.byteLength(body) > 262144) throw new Error("Event exceeds 256 KiB");
    const directory = join(this.root, "inbox", sourceId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (readdirSync(directory).filter((name) => name.endsWith(".json")).length >= 1000)
      throw new Error("Inbox is full");
    const path = join(directory, `${randomUUID()}.tmp`);
    const file = openSync(path, "wx", 0o600);
    try { writeFileSync(file, body); fsyncSync(file); } finally { closeSync(file); }
    renameSync(path, path.replace(/\.tmp$/, ".json"));
  }
  poll(): void {
    let changed = false;
    for (const source of this.store.sources().filter((s) => s.enabled)) {
      const directory = join(this.root, "inbox", source.id);
      try {
        mkdirSync(directory, { recursive: true });
        const files = readdirSync(directory)
          .filter((name) => name.endsWith(".json"))
          .sort();
        if (files.length > 1000) {
          this.store.sourceError(
            source.id,
            "Inbox backlog exceeds 1000 events; processing in batches.",
          );
          changed = true;
        }
        const entries = files
          .slice(0, 1000)
          .map((name) => ({
            path: join(directory, name),
            stat: lstatSync(join(directory, name)),
          }))
          .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
        for (const { path, stat } of entries.slice(0, 100)) {
          try {
            if (!stat.isFile() || stat.isSymbolicLink())
              throw new Error("Only regular event files are accepted");
            if (stat.size > 262144) throw new Error("Event exceeds 256 KiB");
            if (Date.now() - stat.mtimeMs > 7 * 86400000)
              throw new Error("Pending event expired after seven days");
            const envelope: unknown = JSON.parse(readFileSync(path, "utf8"));
            changed =
              this.store.ingest(
                source.id,
                envelope,
                new Date(stat.mtimeMs).toISOString(),
              ) || changed;
          } catch (error) {
            // Disk/database failures must be retryable; malformed events must not poison the queue.
            if (error && typeof error === "object" && "code" in error)
              throw error;
            this.store.sourceError(
              source.id,
              error instanceof SyntaxError
                ? "Invalid event JSON"
                : error instanceof Error
                  ? error.message
                  : "Invalid event",
              true,
            );
            changed = true;
          }
          unlinkSync(path);
        }
        // Remove abandoned temporary files without touching files a collector may still be writing.
        for (const name of readdirSync(directory).filter(
          (n) => !n.endsWith(".json"),
        )) {
          const path = join(directory, name);
          if (Date.now() - lstatSync(path).mtimeMs > 86400000) unlinkSync(path);
        }
      } catch {
        this.store.sourceError(
          source.id,
          "Cannot process inbox. Check disk space and directory permissions; queued events will be retried.",
        );
        changed = true;
      }
    }
    if (changed) this.changed();
  }
  test(sourceId: string): void {
    const source = this.store.source(sourceId);
    if (!source.enabled) throw new Error("Enable the source before testing it");
    const id = randomUUID();
    const directory = join(this.root, "inbox", source.id);
    mkdirSync(directory, { recursive: true });
    const envelope = {
      version: 1,
      eventId: id,
      observedAt: new Date().toISOString(),
      payload:
        source.provider !== "cursor"
          ? {
              hook_event_name: "UserPromptSubmit",
              session_id: `diagnostic-${source.id}`,
              prompt: "Diagnostic chat — local inbox test (not a real agent)",
            }
          : {
              hook_event_name: "beforeSubmitPrompt",
              conversation_id: `diagnostic-${source.id}`,
              prompt: "Diagnostic chat — local inbox test (not a real agent)",
            },
    };
    const path = join(directory, `${id}.tmp`);
    writeFileSync(path, JSON.stringify(envelope));
    renameSync(path, path.replace(/\.tmp$/, ".json"));
    this.poll();
  }
}
