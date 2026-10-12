import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { removeFixture } from "./fixture-cleanup";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/main/store";
import { canonicalPath, repositoryLocation } from "../src/main/repositories";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "acd-repositories-")));
  const root = join(dir, "repo");
  const worktree = join(dir, "worktrees", "temporary-hash");
  execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "pipe" });
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture"], { stdio: "pipe" });
  execFileSync("git", ["-C", root, "worktree", "add", "--detach", worktree], { stdio: "pipe" });
  let store = new Store(join(dir, "workspace.sqlite"));
  store.command({ type: "createSource", name: "Local Claude", provider: "claude", environment: "native" });
  const source = store.sources()[0];
  let sequence = 0;
  const emit = (session: string, cwd: string, hook = "UserPromptSubmit", sourceId = source.id) => store.ingest(sourceId, {
    version: 1, eventId: `event-${++sequence}`, observedAt: new Date(Date.now() + sequence).toISOString(),
    payload: { hook_event_name: hook, session_id: session, cwd, prompt: session },
  });
  t.after(() => { store.close(); removeFixture(dir); });
  return { dir, root, worktree, source, emit, get store() { return store; }, reopen() { store.close(); store = new Store(join(dir, "workspace.sqlite")); } };
}

test("Windows drive and UNC paths remain absolute across repeated normalization", () => {
  for (const [input, expected] of [
    ["C:\\", "c:/"],
    ["C:\\Work\\Deck", "c:/work/deck"],
    ["\\\\Server\\Share\\Deck", "//server/share/deck"],
    ["//Server/Share/Deck", "//server/share/deck"],
  ]) {
    assert.equal(canonicalPath(input), expected);
    assert.equal(canonicalPath(canonicalPath(input)), expected);
  }
});

test("Windows short and long paths discover the same repository and worktree", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t);
  const shortDir = execSync(`for %I in ("${f.dir}") do @echo %~sI`, { encoding: "utf8", windowsHide: true }).trim();
  const longDir = realpathSync.native(f.dir);
  if (canonicalPath(shortDir) === canonicalPath(longDir)) { t.skip("8.3 aliases are unavailable on this volume"); return; }
  const main = repositoryLocation(join(longDir, "repo"), f.source)!;
  assert.ok(main.identity);
  assert.equal(repositoryLocation(join(shortDir, "repo"), f.source)?.identity, main.identity);
  assert.equal(repositoryLocation(join(shortDir, "worktrees", "temporary-hash"), f.source)?.identity, main.identity);
  f.emit("short main", join(shortDir, "repo"));
  f.emit("long main", join(longDir, "repo"));
  f.emit("short worktree", join(shortDir, "worktrees", "temporary-hash"));
  f.reopen();
  assert.equal(f.store.projects().length, 1);
  assert.ok(f.store.chats().every(chat => chat.projectId === f.store.projects()[0].id));
});

test("real linked worktrees use one repository default across providers while user moves survive", t => {
  const f = fixture(t);
  mkdirSync(join(f.worktree, "src"));
  f.emit("worktree task", join(f.worktree, "src"));
  const repo = f.store.projects()[0];
  assert.equal(repo.name, "repo");
  f.emit("main task", f.root);
  f.store.command({ type: "createSource", name: "Other Claude", provider: "claude", environment: "native" });
  const other = f.store.sources().find(s => s.id !== f.source.id)!;
  f.emit("other provider", f.worktree, "UserPromptSubmit", other.id);
  assert.equal(f.store.projects().length, 1);
  assert.ok(f.store.chats().every(c => c.projectId === repo.id && c.repoProjectId === repo.id));
  f.store.command({ type: "renameProject", id: repo.id, name: "My repository" });
  const custom = f.store.createProject("Release work");
  const chat = f.store.chats().find(c => c.externalId === "worktree task")!;
  f.store.command({ type: "updateChat", id: chat.id, patch: { projectId: custom, notes: "Keep my decisions" } });
  f.emit("worktree task", f.worktree, "Stop");
  f.reopen();
  assert.equal(f.store.projects().find(p => p.id === repo.id)!.name, "My repository");
  assert.equal(f.store.chat(chat.id).projectId, custom);
  assert.equal(f.store.chat(chat.id).notes, "Keep my decisions");
  f.store.command({ type: "updateChat", id: chat.id, patch: { projectId: null } });
  f.emit("worktree task", f.worktree);
  assert.equal(f.store.chat(chat.id).projectId, null);
  f.emit("new worktree task", f.worktree);
  assert.equal(f.store.chats().find(c => c.externalId === "new worktree task")!.projectId, repo.id);
});

test("v6 repair consolidates existing worktree rows, preserving names, flags, custom choices, and history", t => {
  const f = fixture(t);
  const main = f.store.createProject("Previously renamed repository", "repo");
  const branch = f.store.createProject("temporary-hash", "repo");
  const custom = f.store.createProject("User release");
  f.store.db.prepare("INSERT INTO workspaces VALUES (?,?,?,?)").run("main", f.source.id, main, canonicalPath(f.root));
  f.store.db.prepare("INSERT INTO workspaces VALUES (?,?,?,?)").run("branch", f.source.id, branch, canonicalPath(f.worktree));
  for (const [id, projectId] of [["default", branch], ["moved", custom], ["unassigned", null]] as const) {
    f.store.db.prepare(`INSERT INTO chats (id,projectId,repoProjectId,provider,sourceId,externalId,name,notes,jiraKey,archived,state,lifecycle,createdAt,updatedAt)
      VALUES (?,?,?,'claude',?,?,?,'Keep notes','APP-42',1,'idle','open','2026-01-01','2026-01-01')`)
      .run(id, projectId, branch, f.source.id, id, `My ${id} task`);
    f.store.db.prepare("INSERT INTO activities VALUES (?,?,?,?,?)").run(`activity-${id}`, id, "2026-01-01", "Stop", "Keep activity");
  }
  f.store.db.prepare("INSERT INTO subagents VALUES (?,?,?,?,?)").run("moved", "agent:worker", "Explore", "unknown", "2026-01-01");
  f.store.command({ type: "setProjectPriority", id: branch, priority: true });
  const moved = f.store.chat("moved");
  const history = f.store.activity("moved");
  f.store.db.exec("DROP TABLE matching_measurements; DROP TABLE matching_feedback; DROP TABLE ai_link_dismissals; DROP TABLE ai_match_attempts; DROP TABLE plan_wrapups; DROP TABLE plan_drafts; DROP TABLE plan_undo; DROP TABLE chat_rounds; DROP TABLE plan_chats; DROP TABLE plan_entries; DROP TABLE plan_imports; DROP TABLE plan_items; DROP TABLE background_snapshots; DROP TABLE chat_links; ALTER TABLE projects DROP COLUMN mergedInto; ALTER TABLE projects DROP COLUMN repositoryPath; PRAGMA user_version=6;");
  f.reopen();
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 13);
  assert.deepEqual(f.store.projects().map(p => p.id).sort(), [main, custom].sort());
  assert.equal(f.store.projects().find(p => p.id === main)!.priority, true);
  assert.equal(f.store.projects().find(p => p.id === main)!.name, "Previously renamed repository");
  assert.deepEqual(f.store.chat("moved"), { ...moved, repoProjectId: main });
  assert.equal(f.store.chat("default").projectId, main);
  assert.equal(f.store.chat("unassigned").projectId, null);
  assert.deepEqual(f.store.activity("moved"), history);
  assert.ok(f.store.workspaces().every(w => w.projectId === main));
  assert.deepEqual(f.store.db.prepare("SELECT name,mergedInto FROM projects WHERE id=?").get(branch), { name: "temporary-hash", mergedInto: main });
  assert.deepEqual(f.store.db.pragma("foreign_key_check"), []);
  const backups = readdirSync(f.dir).filter(n => /^workspace\.sqlite\.bak-\d+$/.test(n));
  assert.equal(backups.length, 1);
  const backup = new Database(join(f.dir, backups[0]), { readonly: true });
  try { assert.equal(backup.pragma("user_version", { simple: true }), 6); } finally { backup.close(); }
  f.reopen();
  assert.equal(readdirSync(f.dir).filter(n => /^workspace\.sqlite\.bak-\d+$/.test(n)).length, 1);
  f.store.command({ type: "renameProject", id: main, name: "Corrected name" });
  f.emit("next task", f.worktree);
  assert.equal(f.store.chats().find(c => c.externalId === "next task")!.projectId, main);
  assert.equal(f.store.projects().find(p => p.id === main)!.name, "Corrected name");
});

test("shared bare worktrees group together while clones and WSL paths remain distinct", t => {
  const f = fixture(t);
  const bare = join(f.dir, "bare.git");
  execFileSync("git", ["clone", "--bare", f.root, bare], { stdio: "pipe" });
  const first = join(f.dir, "bare-first"), second = join(f.dir, "bare-second");
  for (const path of [first, second]) execFileSync("git", ["--git-dir", bare, "worktree", "add", "--detach", path], { stdio: "pipe" });
  f.emit("bare-first", first); f.emit("bare-second", second); f.emit("original", f.root);
  const chats = f.store.chats();
  assert.equal(chats.find(c => c.externalId === "bare-first")!.projectId, chats.find(c => c.externalId === "bare-second")!.projectId);
  assert.notEqual(chats.find(c => c.externalId === "original")!.projectId, chats.find(c => c.externalId === "bare-first")!.projectId);
  f.store.command({ type: "createSource", name: "WSL", provider: "claude", environment: "wsl" });
  const source = f.store.sources().find(s => s.environment === "wsl")!;
  f.emit("wsl-main", f.root, "UserPromptSubmit", source.id);
  f.emit("wsl-worktree", f.worktree, "UserPromptSubmit", source.id);
  const remote = f.store.chats().filter(c => c.sourceId === source.id);
  assert.notEqual(remote[0].projectId, remote[1].projectId);
  assert.ok(remote.every(c => c.projectId !== chats.find(c => c.externalId === "original")!.projectId));
});

test("explicit aliases spanning clones keep their shared default for new linked worktrees", t => {
  const f = fixture(t);
  const clone = join(f.dir, "clone"), linked = join(f.dir, "clone-worktree");
  execFileSync("git", ["clone", f.root, clone], { stdio: "pipe" });
  execFileSync("git", ["-C", clone, "worktree", "add", "--detach", linked], { stdio: "pipe" });
  f.emit("original", f.root);
  const project = f.store.projects()[0];
  f.store.command({ type: "addWorkspace", sourceId: f.source.id, projectId: project.id, path: clone });
  f.emit("clone worktree", linked);
  f.reopen();
  assert.equal(f.store.projects().length, 1);
  assert.ok(f.store.chats().every(c => c.projectId === project.id && c.repoProjectId === project.id));
  f.emit("another clone worktree", linked);
  assert.equal(f.store.chats().find(c => c.externalId === "another clone worktree")!.projectId, project.id);
});

test("repository repair retries when Git markers become available and backs up current data", t => {
  const f = fixture(t);
  const main = f.store.createProject("Main repository", "repo"), branch = f.store.createProject("Worktree", "repo");
  f.store.db.prepare("INSERT INTO workspaces VALUES (?,?,?,?)").run("main", f.source.id, main, canonicalPath(f.root));
  f.store.db.prepare("INSERT INTO workspaces VALUES (?,?,?,?)").run("branch", f.source.id, branch, canonicalPath(f.worktree));
  renameSync(join(f.root, ".git"), join(f.root, ".git-unavailable"));
  f.reopen();
  assert.equal(f.store.projects().length, 2);
  assert.equal(readdirSync(f.dir).filter(n => /^workspace\.sqlite\.bak-\d+$/.test(n)).length, 0);
  renameSync(join(f.root, ".git-unavailable"), join(f.root, ".git"));
  f.reopen();
  assert.deepEqual(f.store.projects().map(p => p.id), [main]);
  const backups = readdirSync(f.dir).filter(n => /^workspace\.sqlite\.bak-\d+$/.test(n));
  assert.equal(backups.length, 1);
  const backup = new Database(join(f.dir, backups[0]), { readonly: true });
  try {
    assert.equal(backup.pragma("user_version", { simple: true }), 13);
    assert.equal((backup.prepare("SELECT COUNT(*) AS count FROM projects WHERE mergedInto IS NULL").get() as { count: number }).count, 2);
  } finally { backup.close(); }
  f.reopen();
  assert.equal(readdirSync(f.dir).filter(n => /^workspace\.sqlite\.bak-\d+$/.test(n)).length, 1);
});

