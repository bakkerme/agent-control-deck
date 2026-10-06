import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, basename, win32, posix, join } from "node:path";
import type {
  Activity,
  Chat,
  Command,
  Project,
  Source,
  Workspace,
  Settings,
} from "../shared/types";
import { commandSchema, envelopeSchema } from "../shared/validation";
import { normalize } from "./providers";

const now = () => new Date().toISOString();
const uuid = () => randomUUID();
export function canonicalPath(value: string): string {
  if (/^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\"))
    return win32
      .normalize(value)
      .replace(/\\/g, "/")
      .replace(/\/$/, "")
      .toLowerCase();
  if (!value.startsWith("/"))
    throw new Error("Workspace paths must be absolute");
  return posix.normalize(value).replace(/\/$/, "") || "/";
}
// Inspect only repository markers on the local host. Remote/WSL paths use
// source-scoped workspace aliases instead of host filesystem guesses.
function repositoryRoot(path: string, source: Source): string | null {
  if (source.environment !== "native" || (process.platform !== "win32" && !path.startsWith("/"))) return null;
  if (process.platform === "win32" && !/^(?:[a-z]:\/|\/\/)/i.test(path)) return null;
  let current = path;
  while (true) {
    if (existsSync(join(current, ".git"))) return canonicalPath(current);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
export class Store {
  readonly db: Database.Database;
  constructor(readonly filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    const existed = existsSync(filename);
    this.db = new Database(filename);
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("journal_mode = WAL");
      const version = this.db.pragma("user_version", {
        simple: true,
      }) as number;
      if (version > 4)
        throw new Error(
          "This database was created by a newer version of Agent Control Deck",
        );
      if (version < 4 && existed) {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
        copyFileSync(filename, `${filename}.bak-${Date.now()}`);
      }
      if (version < 1) {
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL);
            CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, environment TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, lastEventAt TEXT, error TEXT, accepted INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE workspaces (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL REFERENCES sources(id), projectId TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL, UNIQUE(sourceId,path));
            CREATE TABLE chats (id TEXT PRIMARY KEY, projectId TEXT REFERENCES projects(id), provider TEXT NOT NULL, sourceId TEXT REFERENCES sources(id), externalId TEXT, name TEXT NOT NULL DEFAULT '', providerTitle TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', jiraKey TEXT NOT NULL DEFAULT '', jiraUrl TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'unknown', lifecycle TEXT NOT NULL DEFAULT 'open', preview TEXT NOT NULL DEFAULT '', lastEventAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(sourceId,externalId));
            CREATE TABLE activities (id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id), observedAt TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL);
            CREATE INDEX activity_chat_time ON activities(chatId,observedAt DESC);
            CREATE TABLE processed_events (sourceId TEXT NOT NULL REFERENCES sources(id), eventId TEXT NOT NULL, PRIMARY KEY(sourceId,eventId));
            PRAGMA user_version = 2;
          `);
        })();
      }
      if (version === 1) {
        // Disable foreign keys outside the transaction so rebuilding chats cannot
        // remove or retarget the activities that reference it.
        this.db.pragma("foreign_keys = OFF");
        try {
          this.db.transaction(() => {
            this.db.exec(`
              CREATE TABLE chats_new (id TEXT PRIMARY KEY, projectId TEXT REFERENCES projects(id), provider TEXT NOT NULL, sourceId TEXT REFERENCES sources(id), externalId TEXT, name TEXT NOT NULL DEFAULT '', providerTitle TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', jiraKey TEXT NOT NULL DEFAULT '', jiraUrl TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'unknown', lifecycle TEXT NOT NULL DEFAULT 'open', preview TEXT NOT NULL DEFAULT '', lastEventAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(sourceId,externalId));
              INSERT INTO chats_new SELECT * FROM chats;
              DROP TABLE chats;
              ALTER TABLE chats_new RENAME TO chats;
              PRAGMA user_version = 2;
            `);
            if ((this.db.pragma("foreign_key_check") as unknown[]).length)
              throw new Error("Database migration failed its relationship check");
          })();
        } finally {
          this.db.pragma("foreign_keys = ON");
        }
      }
      if (version < 3) {
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            PRAGMA user_version = 3;
          `);
        })();
      }
      if (version < 4) {
        this.db.transaction(() => {
          this.db.exec(`
            ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom' CHECK(kind IN ('repo','custom'));
            ALTER TABLE chats ADD COLUMN repoProjectId TEXT REFERENCES projects(id);
            UPDATE projects SET kind='repo' WHERE id IN (SELECT projectId FROM workspaces);
            UPDATE chats SET repoProjectId=projectId WHERE provider!='manual' AND EXISTS
              (SELECT 1 FROM workspaces WHERE workspaces.sourceId=chats.sourceId AND workspaces.projectId=chats.projectId);
            PRAGMA user_version = 4;
          `);
          // Old versions could create one project per subfolder/provider. Join
          // only roots proven on this host, retaining old assignments as custom
          // groupings so no user organization or project names are lost.
          const repositories = new Map<string, Workspace[]>();
          for (const workspace of this.workspaces()) {
            const root = repositoryRoot(workspace.path, this.source(workspace.sourceId));
            if (root) repositories.set(root, [...(repositories.get(root) ?? []), workspace]);
          }
          for (const [root, workspaces] of repositories) {
            const primary = workspaces.find(w => w.path === root) ?? workspaces[0];
            for (const workspace of workspaces) {
              this.db.prepare("UPDATE chats SET repoProjectId=? WHERE sourceId=? AND repoProjectId=?")
                .run(primary.projectId, workspace.sourceId, workspace.projectId);
              this.db.prepare("UPDATE workspaces SET projectId=? WHERE id=?").run(primary.projectId, workspace.id);
              this.db.prepare("INSERT INTO workspaces VALUES (?,?,?,?) ON CONFLICT(sourceId,path) DO NOTHING")
                .run(uuid(), workspace.sourceId, primary.projectId, root);
            }
          }
          this.db.prepare("UPDATE projects SET kind='custom' WHERE id NOT IN (SELECT projectId FROM workspaces)").run();
        })();
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  projects(): Project[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE, id")
      .all() as Project[];
  }
  settings(): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='jiraBaseUrl'").get() as { value: string } | undefined;
    return { jiraBaseUrl: row?.value ?? "" };
  }
  chats(): Chat[] {
    return (
      this.db
        .prepare("SELECT * FROM chats ORDER BY createdAt,id")
        .all() as Chat[]
    ).map((c) => ({ ...c, archived: !!c.archived }));
  }
  sources(): Source[] {
    return (
      this.db
        .prepare("SELECT * FROM sources ORDER BY name,id")
        .all() as Source[]
    ).map((s) => ({ ...s, enabled: !!s.enabled }));
  }
  workspaces(): Workspace[] {
    return this.db
      .prepare("SELECT * FROM workspaces ORDER BY path")
      .all() as Workspace[];
  }
  chat(id: string): Chat {
    const row = this.db.prepare("SELECT * FROM chats WHERE id=?").get(id) as
      Chat | undefined;
    if (!row) throw new Error("Chat no longer exists");
    return { ...row, archived: !!row.archived };
  }
  source(id: string): Source {
    const source = this.sources().find((s) => s.id === id);
    if (!source) throw new Error("Source no longer exists");
    return source;
  }
  activity(id: string): Activity[] {
    return this.db
      .prepare(
        "SELECT * FROM activities WHERE chatId=? ORDER BY observedAt DESC, rowid DESC LIMIT 100",
      )
      .all(id) as Activity[];
  }
  private requireProject(id: string): void {
    if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(id))
      throw new Error("Choose an existing project");
  }
  createProject(name: string, kind: Project["kind"] = "custom"): string {
    const id = uuid();
    this.db.prepare("INSERT INTO projects (id,name,createdAt,kind) VALUES (?,?,?,?)").run(id, name, now(), kind);
    return id;
  }
  command(raw: Command): void {
    const c = commandSchema.parse(raw);
    switch (c.type) {
      case "updateSettings":
        this.db.prepare("INSERT INTO settings (key,value) VALUES ('jiraBaseUrl',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(c.jiraBaseUrl);
        break;
      case "createProject":
        this.db.transaction(() => {
          if (c.chatId) this.chat(c.chatId);
          const projectId = this.createProject(c.name);
          if (c.chatId) this.db.prepare("UPDATE chats SET projectId=?,updatedAt=? WHERE id=?").run(projectId, now(), c.chatId);
        })();
        break;
      case "renameProject":
        this.requireProject(c.id);
        if (this.projects().find(p => p.id === c.id)?.kind === "repo")
          throw new Error("Repository projects have a permanent name");
        this.db
          .prepare("UPDATE projects SET name=? WHERE id=?")
          .run(c.name, c.id);
        break;
      case "createChat": {
        if (c.projectId !== null) this.requireProject(c.projectId);
        this.db
          .prepare(
            "INSERT INTO chats (id,projectId,provider,name,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
          )
          .run(uuid(), c.projectId, "manual", c.name, now(), now());
        break;
      }
      case "updateChat": {
        const old = this.chat(c.id);
        if (
          old.provider !== "manual" &&
          (c.patch.state !== undefined || c.patch.lifecycle !== undefined)
        )
          throw new Error("Live chat state is reported by its provider");
        if (c.patch.projectId) this.requireProject(c.patch.projectId);
        if (old.repoProjectId && c.patch.projectId && c.patch.projectId !== old.projectId && c.patch.projectId !== old.repoProjectId && this.projects().find(p => p.id === c.patch.projectId)?.kind === "repo")
          throw new Error("Choose a custom project to group this chat");
        if (old.provider === "manual" && c.patch.name === "")
          throw new Error("A manual chat needs a name");
        const entries = Object.entries(c.patch).filter(
          ([, value]) => value !== undefined,
        );
        if (entries.length)
          this.db
            .prepare(
              `UPDATE chats SET ${entries.map(([key]) => `${key}=?`).join(",")},updatedAt=? WHERE id=?`,
            )
            .run(
              ...entries.map(([, value]) =>
                typeof value === "boolean" ? Number(value) : value,
              ),
              now(),
              c.id,
            );
        break;
      }
      case "createSource":
        this.db
          .prepare(
            "INSERT INTO sources (id,name,provider,environment) VALUES (?,?,?,?)",
          )
          .run(uuid(), c.name, c.provider, c.environment);
        break;
      case "updateSource":
        this.source(c.id);
        this.db
          .prepare("UPDATE sources SET enabled=? WHERE id=?")
          .run(Number(c.enabled), c.id);
        break;
      case "addWorkspace": {
        const source = this.source(c.sourceId);
        this.requireProject(c.projectId);
        const reported = canonicalPath(c.path);
        const root = repositoryRoot(reported, source);
        const path = root ?? reported;
        this.db.transaction(() => {
          const existing = this.workspaces().find(w => w.path === path &&
            (w.sourceId === c.sourceId || (root && this.source(w.sourceId).environment === "native")));
          if (existing && existing.projectId !== c.projectId)
            throw new Error("A repository's project cannot be changed");
          this.db.prepare("UPDATE projects SET kind='repo' WHERE id=?").run(c.projectId);
          this.db
            .prepare(
              "INSERT INTO workspaces VALUES (?,?,?,?) ON CONFLICT(sourceId,path) DO NOTHING",
            )
            .run(uuid(), c.sourceId, c.projectId, path);
        })();
        break;
      }
      case "removeWorkspace":
        if (this.workspaces().some(w => w.id === c.id))
          throw new Error("Repository mappings are permanent");
        break;
      default:
        throw new Error("This command is handled by the application");
    }
  }
  private projectFor(sourceId: string, workspace: string | null): string | null {
    const reported = workspace ? canonicalPath(workspace) : null;
    const root = reported ? repositoryRoot(reported, this.source(sourceId)) : null;
    const path = root ?? reported;
    const matches = this.workspaces()
      .filter(
        (w) =>
          w.sourceId === sourceId &&
          path &&
          (path === w.path || (!root &&
            path.startsWith(w.path.endsWith("/") ? w.path : w.path + "/"))),
      )
      .sort((a, b) => b.path.length - a.path.length);
    if (matches[0]) return matches[0].projectId;
    if (!path) return null;
    // An accessible Git root establishes identity across native providers;
    // other paths stay source-scoped and can be joined by explicit aliases.
    const shared = root ? this.workspaces().find(w => w.path === root && this.source(w.sourceId).environment === "native") : undefined;
    const id = shared?.projectId ?? this.createProject(basename(path) || path, "repo");
    this.db
      .prepare("INSERT INTO workspaces VALUES (?,?,?,?)")
      .run(uuid(), sourceId, id, path);
    return id;
  }
  ingest(sourceId: string, raw: unknown, fallbackTime = now()): boolean {
    const source = this.source(sourceId);
    const envelope = envelopeSchema.parse(raw);
    const observedAt = new Date(
      envelope.observedAt ?? fallbackTime,
    ).toISOString();
    if (Date.parse(observedAt) > Date.now() + 300000)
      throw new Error("Event timestamp is too far in the future");
    const observation = normalize(source, envelope.payload);
    return this.db.transaction(() => {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM processed_events WHERE sourceId=? AND eventId=?",
          )
          .get(sourceId, envelope.eventId)
      )
        return false;
      this.db
        .prepare("INSERT INTO processed_events VALUES (?,?)")
        .run(sourceId, envelope.eventId);
      if (!observation) return false;
      let chat = this.chats().find(
        (c) =>
          c.sourceId === sourceId && c.externalId === observation.externalId,
      );
      if (!chat) {
        // Discover resumed and new chats only when a prompt is submitted.
        if (!["UserPromptSubmit", "beforeSubmitPrompt"].includes(observation.kind)) return false;
        const id = uuid();
        const repoProjectId = this.projectFor(sourceId, observation.workspace);
        this.db
          .prepare(
            "INSERT INTO chats (id,projectId,repoProjectId,provider,sourceId,externalId,providerTitle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            repoProjectId,
            repoProjectId,
            source.provider,
            sourceId,
            observation.externalId,
            { claude: "Claude chat", cursor: "Cursor chat", codex: "Codex chat" }[source.provider],
            now(),
            now(),
          );
        chat = this.chat(id);
      }
      if (!chat.repoProjectId && observation.workspace) {
        this.db.prepare("UPDATE chats SET repoProjectId=? WHERE id=?")
          .run(this.projectFor(sourceId, observation.workspace), chat.id);
      }
      this.db
        .prepare("INSERT INTO activities VALUES (?,?,?,?,?)")
        .run(
          uuid(),
          chat.id,
          observedAt,
          observation.kind,
          observation.summary,
        );
      this.db
        .prepare(
          "DELETE FROM activities WHERE chatId=? AND id NOT IN (SELECT id FROM activities WHERE chatId=? ORDER BY observedAt DESC,rowid DESC LIMIT 100)",
        )
        .run(chat.id, chat.id);
      if (!chat.lastEventAt || observedAt >= chat.lastEventAt) {
        const providerTitle =
          observation.title &&
          ["Claude chat", "Cursor chat", "Codex chat"].includes(chat.providerTitle)
            ? observation.title
            : chat.providerTitle;
        this.db
          .prepare(
            "UPDATE chats SET state=?,lifecycle=?,preview=?,providerTitle=?,lastEventAt=? WHERE id=?",
          )
          .run(
            observation.state ?? chat.state,
            observation.lifecycle ?? chat.lifecycle,
            observation.preview ?? chat.preview,
            providerTitle,
            observedAt,
            chat.id,
          );
      }
      this.db
        .prepare(
          "UPDATE sources SET lastEventAt=CASE WHEN lastEventAt IS NULL OR lastEventAt<? THEN ? ELSE lastEventAt END, accepted=accepted+1,error=NULL WHERE id=?",
        )
        .run(observedAt, observedAt, sourceId);
      return true;
    })();
  }
  sourceError(id: string, message: string, rejected = false): void {
    this.db
      .prepare("UPDATE sources SET error=?,rejected=rejected+? WHERE id=?")
      .run(message.slice(0, 500), Number(rejected), id);
  }
}
