import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import type {
  Activity,
  Chat,
  Command,
  Project,
  Source,
  Workspace,
  Settings,
  Subagent,
  ChatLink,
} from "../shared/types";
import { PlanningStore } from "./planning-store";
import { commandSchema, envelopeSchema } from "../shared/validation";
import { normalize, type Observation } from "./providers";
import { canonicalPath, repositoryLocation, repositoryRoot } from "./repositories";
import { MAX_CHAT_LINKS } from "../shared/links";
export { canonicalPath } from "./repositories";

type ChatRow = Omit<Chat, "subagents" | "backgroundTasks" | "scheduledChecks"> & { subagentBaselineAt: string | null };
type BackgroundSnapshotRow = { chatId: string; kind: "backgroundTasks" | "scheduledChecks"; state: "observed" | "unknown"; lastEventAt: string; items: string };
type SubagentRow = Subagent & { chatId: string };
type ProjectRow = Project & { repositoryPath: string | null; mergedInto: string | null };

const now = () => new Date().toISOString();
const uuid = () => randomUUID();
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
      if (version > 10)
        throw new Error(
          "This database was created by a newer version of Agent Control Deck",
        );
      if (version < 10 && existed) {
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
      if (version < 5) {
        this.db.transaction(() => {
          this.db.exec(`
            ALTER TABLE chats ADD COLUMN subagentBaselineAt TEXT;
            CREATE TABLE subagents (
              chatId TEXT NOT NULL REFERENCES chats(id), id TEXT NOT NULL,
              type TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','unknown','finished')),
              lastEventAt TEXT NOT NULL, PRIMARY KEY(chatId,id)
            );
            PRAGMA user_version = 5;
          `);
        })();
      }
      if (version < 6) {
        this.db.transaction(() => {
          this.db.exec(`
            ALTER TABLE projects ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority IN (0,1));
            PRAGMA user_version = 6;
          `);
        })();
      }
      if (version < 7) {
        this.db.transaction(() => {
          this.db.exec(`
            ALTER TABLE projects ADD COLUMN repositoryPath TEXT;
            ALTER TABLE projects ADD COLUMN mergedInto TEXT REFERENCES projects(id);
            PRAGMA user_version = 7;
          `);
        })();
      }
      if (version < 8) {
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE chat_links (
              id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id),
              url TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', firstSeenAt TEXT NOT NULL,
              lastSeenAt TEXT NOT NULL, UNIQUE(chatId,url)
            );
            CREATE INDEX chat_links_time ON chat_links(chatId,lastSeenAt DESC);
            PRAGMA user_version = 8;
          `);
        })();
      }
      if (version < 9) {
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE background_snapshots (
              chatId TEXT NOT NULL REFERENCES chats(id), kind TEXT NOT NULL CHECK(kind IN ('backgroundTasks','scheduledChecks')),
              state TEXT NOT NULL CHECK(state IN ('observed','unknown')), lastEventAt TEXT NOT NULL,
              items TEXT NOT NULL, PRIMARY KEY(chatId,kind)
            );
            PRAGMA user_version = 9;
          `);
        })();
      }
      if (version < 10) {
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE plan_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', projectId TEXT REFERENCES projects(id), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
            CREATE TABLE plan_entries (day TEXT NOT NULL, itemId TEXT NOT NULL REFERENCES plan_items(id), category TEXT NOT NULL CHECK(category IN ('Coding','Agentic','Other')), workedOn INTEGER NOT NULL DEFAULT 0 CHECK(workedOn IN (0,1)), position INTEGER NOT NULL, PRIMARY KEY(day,itemId));
            CREATE TABLE plan_chats (itemId TEXT NOT NULL REFERENCES plan_items(id), chatId TEXT NOT NULL REFERENCES chats(id), PRIMARY KEY(itemId,chatId));
            CREATE TABLE plan_imports (id TEXT PRIMARY KEY, day TEXT NOT NULL, sourceName TEXT NOT NULL, markdown TEXT NOT NULL, importedAt TEXT NOT NULL);
            PRAGMA user_version = 10;
          `);
        })();
      }
      this.reconcileRepositories(() => {
        if (version >= 10 && existed) {
          this.db.pragma("wal_checkpoint(TRUNCATE)");
          copyFileSync(filename, `${filename}.bak-${Date.now()}`);
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  projects(): Project[] {
    return (this.db
      .prepare("SELECT id,name,createdAt,kind,priority FROM projects WHERE mergedInto IS NULL ORDER BY name COLLATE NOCASE, id")
      .all() as Project[]).map(p => ({ ...p, priority: !!p.priority }));
  }
  settings(): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='jiraBaseUrl'").get() as { value: string } | undefined;
    const rules = this.db.prepare("SELECT value FROM settings WHERE key='linkRules'").get() as { value: string } | undefined;
    return { jiraBaseUrl: row?.value ?? "", linkRules: rules ? JSON.parse(rules.value) : [] };
  }
  links(): ChatLink[] {
    return this.db.prepare("SELECT * FROM chat_links ORDER BY lastSeenAt DESC,id").all() as ChatLink[];
  }
  link(id: string): ChatLink {
    const row = this.db.prepare("SELECT * FROM chat_links WHERE id=?").get(id) as ChatLink | undefined;
    if (!row) throw new Error("Link no longer exists");
    return row;
  }
  chats(): Chat[] {
    const background = this.backgroundObservations();
    const agents = new Map<string, Subagent[]>();
    for (const { chatId, ...agent } of this.db.prepare("SELECT * FROM subagents WHERE state!='finished' ORDER BY id").all() as SubagentRow[]) {
      const group = agents.get(chatId) ?? [];
      group.push(agent);
      agents.set(chatId, group);
    }
    return (this.db.prepare("SELECT * FROM chats ORDER BY createdAt,id").all() as ChatRow[])
      .map(({ subagentBaselineAt, ...c }) => ({ ...c, archived: !!c.archived, subagents: agents.get(c.id) ?? [],
        ...(background.get(c.id) ?? { backgroundTasks: [], scheduledChecks: [] }) }));
  }
  private backgroundObservations(chatId?: string): Map<string, Pick<Chat, "backgroundTasks" | "scheduledChecks">> {
    const result = new Map<string, Pick<Chat, "backgroundTasks" | "scheduledChecks">>();
    const rows = chatId === undefined
      ? this.db.prepare("SELECT * FROM background_snapshots").all()
      : this.db.prepare("SELECT * FROM background_snapshots WHERE chatId=?").all(chatId);
    for (const row of rows as BackgroundSnapshotRow[]) {
      const group = result.get(row.chatId) ?? { backgroundTasks: [], scheduledChecks: [] };
      const items = JSON.parse(row.items).map((item: { id: string }) => ({ ...item, state: row.state, lastEventAt: row.lastEventAt }));
      group[row.kind] = items;
      result.set(row.chatId, group);
    }
    return result;
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
    const row = this.db.prepare("SELECT * FROM chats WHERE id=?").get(id) as ChatRow | undefined;
    if (!row) throw new Error("Chat no longer exists");
    const { subagentBaselineAt, ...chat } = row;
    const subagents = (this.db.prepare("SELECT * FROM subagents WHERE chatId=? AND state!='finished' ORDER BY id").all(id) as SubagentRow[])
      .map(({ chatId, ...agent }) => agent);
    return { ...chat, archived: !!chat.archived, subagents,
      ...(this.backgroundObservations(id).get(id) ?? { backgroundTasks: [], scheduledChecks: [] }) };
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
    if (!this.db.prepare("SELECT id FROM projects WHERE id=? AND mergedInto IS NULL").get(id))
      throw new Error("Choose an existing project");
  }
  createProject(name: string, kind: Project["kind"] = "custom"): string {
    const id = uuid();
    this.db.prepare("INSERT INTO projects (id,name,createdAt,kind) VALUES (?,?,?,?)").run(id, name, now(), kind);
    return id;
  }
  command(raw: Command): void {
    const c = commandSchema.parse(raw);
    if (new PlanningStore(this).command(c)) return;
    switch (c.type) {
      case "updateSettings":
        this.db.transaction(() => {
          const save = this.db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
          if (c.jiraBaseUrl !== undefined) save.run("jiraBaseUrl", c.jiraBaseUrl);
          if (c.linkRules !== undefined) save.run("linkRules", JSON.stringify(c.linkRules));
        })();
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
        this.db
          .prepare("UPDATE projects SET name=? WHERE id=?")
          .run(c.name, c.id);
        break;
      case "setProjectPriority":
        this.requireProject(c.id);
        this.db.prepare("UPDATE projects SET priority=? WHERE id=?").run(c.priority ? 1 : 0, c.id);
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
        const location = repositoryLocation(reported, source);
        const root = location?.root;
        const path = root ?? reported;
        this.db.transaction(() => {
          this.reconcileRepositories();
          const established = location?.identity ? this.repositoryProject(location.identity) : undefined;
          if (established && established.id !== c.projectId)
            throw new Error("Use the existing repository project for this path");
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
          this.reconcileRepositories();
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
  private repositoryProject(identity: string): ProjectRow | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE repositoryPath=? AND mergedInto IS NULL ORDER BY createdAt,id LIMIT 1").get(identity) as ProjectRow | undefined;
  }
  private reconcileRepositories(beforeChange?: () => void): void {
    const projects = this.db.prepare("SELECT * FROM projects WHERE mergedInto IS NULL ORDER BY createdAt,id").all() as ProjectRow[];
    const sources = new Map(this.sources().map(s => [s.id, s]));
    const groups = new Map<string, { workspaces: Workspace[]; ids: Set<string> }>();
    const identities = new Map<string, Set<string>>();
    for (const workspace of this.workspaces()) {
      const source = sources.get(workspace.sourceId);
      const location = source && repositoryLocation(workspace.path, source);
      if (!location?.identity) continue;
      const group = groups.get(location.identity) ?? { workspaces: [], ids: new Set<string>() };
      group.workspaces.push(workspace);
      group.ids.add(workspace.projectId);
      groups.set(location.identity, group);
      const keys = identities.get(workspace.projectId) ?? new Set<string>();
      keys.add(location.identity);
      identities.set(workspace.projectId, keys);
    }
    const plans: { identity: string; primary: ProjectRow; duplicates: ProjectRow[] }[] = [];
    for (const [identity, group] of groups) {
      // Explicit aliases can span separate clones. Keep those choices; neither
      // folder names nor a shared assignment prove Git identity.
      if ([...group.ids].some(id => (identities.get(id)?.size ?? 0) > 1)) continue;
      const eligible = (p: ProjectRow) => !identities.has(p.id) || identities.get(p.id)!.has(identity);
      const established = projects.filter(p => p.repositoryPath === identity && eligible(p));
      const candidates = projects.filter(p => group.ids.has(p.id));
      const mainPath = identity.endsWith("/.git") ? dirname(identity) : null;
      const mainId = [...group.workspaces].sort((a, b) => a.path.length - b.path.length)
        .find(w => repositoryRoot(w.path, sources.get(w.sourceId)!) === mainPath)?.projectId;
      const primary = established[0] ?? candidates.find(p => p.id === mainId) ?? candidates[0];
      if (!primary) continue;
      const duplicates = projects.filter(p => p.id !== primary.id && (group.ids.has(p.id) || (p.repositoryPath === identity && eligible(p))));
      if (duplicates.length || primary.repositoryPath !== identity) plans.push({ identity, primary, duplicates });
    }
    if (!plans.length) return;
    beforeChange?.();
    this.db.transaction(() => {
      for (const { identity, primary, duplicates } of plans) {
        this.db.prepare("UPDATE projects SET repositoryPath=?,priority=? WHERE id=?")
          .run(identity, Number(!!primary.priority || duplicates.some(p => !!p.priority)), primary.id);
        for (const duplicate of duplicates) {
          // Consolidate repository defaults, keeping unrelated custom choices
          // and all chat content, activity, subagents, and archive state intact.
          this.db.prepare("UPDATE chats SET repoProjectId=? WHERE repoProjectId=?").run(primary.id, duplicate.id);
          this.db.prepare("UPDATE chats SET projectId=? WHERE projectId=?").run(primary.id, duplicate.id);
          this.db.prepare("UPDATE plan_items SET projectId=? WHERE projectId=?").run(primary.id, duplicate.id);
          this.db.prepare("UPDATE workspaces SET projectId=? WHERE projectId=?").run(primary.id, duplicate.id);
          this.db.prepare("UPDATE projects SET mergedInto=? WHERE mergedInto=?").run(primary.id, duplicate.id);
          // Retain the old record/name for recovery without a duplicate sidebar row.
          this.db.prepare("UPDATE projects SET mergedInto=? WHERE id=?").run(primary.id, duplicate.id);
        }
      }
    })();
  }
  private projectFor(sourceId: string, workspace: string | null): string | null {
    const reported = workspace ? canonicalPath(workspace) : null;
    const location = reported ? repositoryLocation(reported, this.source(sourceId)) : null;
    const root = location?.root;
    if (location?.identity) this.reconcileRepositories();
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
    const established = location?.identity ? this.repositoryProject(location.identity) : undefined;
    const shared = !established && root ? this.workspaces().find(w => {
      const source = this.source(w.sourceId);
      return source.environment === "native" && (w.path === root || (location?.identity && repositoryLocation(w.path, source)?.identity === location.identity));
    }) : undefined;
    const id = established?.id ?? shared?.projectId ?? this.createProject(location?.name || basename(path) || path, "repo");
    if (location?.identity && !established && !shared)
      this.db.prepare("UPDATE projects SET repositoryPath=? WHERE id=?").run(location.identity, id);
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
      this.observeSubagents(chat.id, observation, observedAt);
      this.observeBackground(chat.id, observation, observedAt);
      if (observation.links?.length) {
        const save = this.db.prepare(`INSERT INTO chat_links VALUES (?,?,?,?,?,?)
          ON CONFLICT(chatId,url) DO UPDATE SET
            label=CASE WHEN excluded.label!='' AND (chat_links.label='' OR excluded.lastSeenAt>=chat_links.lastSeenAt) THEN excluded.label ELSE chat_links.label END,
            firstSeenAt=MIN(chat_links.firstSeenAt,excluded.firstSeenAt), lastSeenAt=MAX(chat_links.lastSeenAt,excluded.lastSeenAt)`);
        for (const link of observation.links) save.run(uuid(), chat.id, link.url, link.label, observedAt, observedAt);
        this.db.prepare(`DELETE FROM chat_links WHERE chatId=? AND id NOT IN
          (SELECT id FROM chat_links WHERE chatId=? ORDER BY lastSeenAt DESC,rowid DESC LIMIT ?)`)
          .run(chat.id, chat.id, MAX_CHAT_LINKS);
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
  private observeSubagents(chatId: string, observation: Observation, observedAt: string): void {
    const { subagent, backgroundSubagents } = observation;
    if (!subagent && backgroundSubagents === undefined && observation.lifecycle !== "ended") return;
    const baseline = (this.db.prepare("SELECT subagentBaselineAt FROM chats WHERE id=?").get(chatId) as ChatRow).subagentBaselineAt;
    if (baseline && observedAt < baseline) return;
    const upsert = (id: string, type: string, state: "running" | "finished") => {
      this.db.prepare(`INSERT INTO subagents VALUES (?,?,?,?,?) ON CONFLICT(chatId,id) DO UPDATE SET
        type=CASE WHEN excluded.type='' THEN subagents.type ELSE excluded.type END,
        state=excluded.state,lastEventAt=excluded.lastEventAt WHERE excluded.lastEventAt>=subagents.lastEventAt`)
        .run(chatId, id, type, state, observedAt);
    };
    if (backgroundSubagents !== undefined) {
      // Claude's task registry IDs are not necessarily lifecycle agent IDs.
      // Replace observations at this boundary; a later registry snapshot resolves
      // completions without guessing how the two ID namespaces relate.
      this.db.prepare("UPDATE subagents SET state='finished',lastEventAt=? WHERE chatId=? AND lastEventAt<=?")
        .run(observedAt, chatId, observedAt);
      for (const agent of backgroundSubagents) upsert(`background:${agent.id}`, agent.type, "running");
      this.db.prepare("UPDATE chats SET subagentBaselineAt=? WHERE id=?").run(observedAt, chatId);
    } else if (observation.lifecycle === "ended") {
      this.db.prepare("UPDATE subagents SET state='unknown',lastEventAt=? WHERE chatId=? AND state!='finished' AND lastEventAt<=?")
        .run(observedAt, chatId, observedAt);
      this.db.prepare("UPDATE chats SET subagentBaselineAt=? WHERE id=?").run(observedAt, chatId);
    } else if (subagent && (!baseline || observedAt >= baseline)) {
      if (subagent.id) upsert(`agent:${subagent.id}`, subagent.type, subagent.running ? "running" : "finished");
      if (!subagent.running) {
        // Cursor's documented stop payload may omit the instance ID. Likewise,
        // a Claude stop without a registry snapshot cannot identify registry IDs.
        this.db.prepare(`UPDATE subagents SET state='unknown',lastEventAt=? WHERE chatId=? AND state!='finished'
          AND lastEventAt<=? AND (? OR id LIKE 'background:%')`)
          .run(observedAt, chatId, observedAt, Number(!subagent.id));
        if (!subagent.id) this.db.prepare("UPDATE chats SET subagentBaselineAt=? WHERE id=?").run(observedAt, chatId);
      }
    }
    this.db.prepare(`DELETE FROM subagents WHERE chatId=? AND state='finished' AND id NOT IN
      (SELECT id FROM subagents WHERE chatId=? AND state='finished' ORDER BY lastEventAt DESC,rowid DESC LIMIT 1000)`)
      .run(chatId, chatId);
    const count = this.db.prepare("SELECT COUNT(*) AS total FROM subagents WHERE chatId=? AND state!='finished'").get(chatId) as { total: number };
    if (count.total > 1000) throw Object.assign(new Error("Subagent observation capacity reached; pending event retained"), { code: "ACD_SUBAGENT_CAPACITY" });
  }
  private observeBackground(chatId: string, observation: Observation, observedAt: string): void {
    for (const kind of ["backgroundTasks", "scheduledChecks"] as const) {
      const items = observation[kind];
      if (items !== undefined) {
        // Empty snapshots are retained as boundaries against delayed events.
        // An absent field does not establish that existing work completed.
        this.db.prepare(`INSERT INTO background_snapshots VALUES (?,?,?,?,?) ON CONFLICT(chatId,kind) DO UPDATE SET
          state=excluded.state,lastEventAt=excluded.lastEventAt,items=excluded.items
          WHERE excluded.lastEventAt>=background_snapshots.lastEventAt`)
          .run(chatId, kind, "observed", observedAt, JSON.stringify(items));
      } else if (observation.lifecycle === "ended") {
        this.db.prepare(`INSERT INTO background_snapshots VALUES (?,?,?,?,?) ON CONFLICT(chatId,kind) DO UPDATE SET
          state='unknown',lastEventAt=excluded.lastEventAt WHERE excluded.lastEventAt>=background_snapshots.lastEventAt`)
          .run(chatId, kind, "unknown", observedAt, "[]");
      }
    }
  }
  sourceError(id: string, message: string, rejected = false): void {
    this.db
      .prepare("UPDATE sources SET error=?,rejected=rejected+? WHERE id=?")
      .run(message.slice(0, 500), Number(rejected), id);
  }
}
