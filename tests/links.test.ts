import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/main/store";
import { normalize } from "../src/main/providers";
import { detectLinks, linkCategory, linkLabel, MAX_CHAT_LINKS, MAX_EVENT_LINKS } from "../src/shared/links";
import { commandSchema, linkRulesSchema } from "../src/shared/validation";
import type { Source } from "../src/shared/types";

test("link detection handles Markdown labels, prose punctuation, balanced URLs and duplicates", () => {
  assert.deepEqual(detectLinks('Read [Rollout plan](https://team.example/wiki/plan), then https://team.example/wiki/plan. See <https://team.example/browse/APP-2> and (https://example.org/Function_(math)).'), [
    { url: "https://team.example/wiki/plan", label: "Rollout plan" },
    { url: "https://team.example/browse/APP-2", label: "" },
    { url: "https://example.org/Function_(math)", label: "" },
  ]);
  assert.deepEqual(detectLinks('https://EXAMPLE.org [A title](https://example.org/)'), [{ url: "https://example.org/", label: "A title" }]);
  assert.deepEqual(detectLinks('[Plan](https://example.org/Function_(math))[Ticket](https://example.org/2)'), [
    { url: "https://example.org/Function_(math)", label: "Plan" }, { url: "https://example.org/2", label: "Ticket" },
  ]);
  assert.equal(linkLabel({ url: "https://example.org/plan?version=2#notes", label: "" }), "example.org/plan?version=2#notes");
  assert.equal(linkLabel({ url: "https://example.org/", label: "Supplied title" }), "Supplied title");
});

test("detector excludes credentials and unsafe schemes, and bounds untrusted input", () => {
  assert.deepEqual(detectLinks('javascript:alert(1) file:///tmp/a https://user:secret@example.org/a https:// http://'), []);
  assert.equal(detectLinks(`https://example.org/${"x".repeat(3000)}`).length, 0);
  assert.equal(detectLinks(Array.from({ length: 150 }, (_, i) => `https://example.org/${i}`).join(" ")).length, MAX_EVENT_LINKS);
  assert.equal(detectLinks(`https://example.org/${")".repeat(250000)}`).length, 0);
});

test("domain rules are exact, path bounded and most specific; removing rules retains Other", () => {
  const rules = linkRulesSchema.parse([
    { domain: " TEAM.EXAMPLE ", pathPrefix: "", category: "Everything" },
    { domain: "team.example", pathPrefix: "/wiki/", category: " Documents " },
    { domain: "team.example", pathPrefix: "/wiki/payments", category: "Payments" },
  ]);
  assert.equal(linkCategory("https://team.example/wiki/payments/plan", rules), "Payments");
  assert.equal(linkCategory("https://team.example/wiki", rules), "Documents");
  assert.equal(linkCategory("https://team.example/wikipedia", rules), "Everything");
  assert.equal(linkCategory("https://team.example.evil/wiki", rules), "Other");
  assert.equal(linkCategory("https://sub.team.example/wiki", rules), "Other");
  assert.equal(linkCategory("https://team.example/wiki", []), "Other");
  for (const domain of ["https://team.example", "team.example/path", "user@team.example", "team.example:8080", "*.example", "team.example#x"]) {
    assert.equal(linkRulesSchema.safeParse([{ domain, pathPrefix: "", category: "Docs" }]).success, false, domain);
  }
  assert.equal(linkRulesSchema.safeParse([{ domain: "team.example", pathPrefix: "wiki", category: "Docs" }]).success, false);
  assert.equal(linkRulesSchema.safeParse([rules[0], rules[0]]).success, false);
  assert.equal(commandSchema.safeParse({ type: "updateSettings" }).success, false);
});

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "acd-links-"));
  const filename = join(dir, "workspace.sqlite");
  let store = new Store(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.command({ type: "createSource", provider: "claude", environment: "native", name: "Test" });
  const source = store.sources()[0];
  const emit = (id: string, kind: string, extra = {}, time = "2026-01-01T00:00:00Z") => store.ingest(source.id, {
    version: 1, eventId: id, observedAt: time, payload: { hook_event_name: kind, session_id: "chat", ...extra },
  });
  return { dir, filename, source, emit, get store() { return store; }, reopen() { store.close(); store = new Store(filename); return store; } };
}

test("all response adapters extract links beyond preview truncation, including child responses", () => {
  for (const provider of ["claude", "codex", "cursor"] as const) {
    const source = { provider } as Source;
    const content = `${"a".repeat(600)} [Plan](https://team.example/wiki/plan)`;
    const observation = normalize(source, provider === "cursor"
      ? { hook_event_name: "afterAgentResponse", conversation_id: "chat", text: content }
      : { hook_event_name: "Stop", session_id: "chat", last_assistant_message: content });
    assert.equal(observation?.preview?.length, 500);
    assert.deepEqual(observation?.links, [{ url: "https://team.example/wiki/plan", label: "Plan" }]);
    if (provider !== "cursor") {
      const child = normalize(source, { hook_event_name: "SubagentStop", session_id: "chat", agent_id: "worker", last_assistant_message: content });
      assert.equal(child?.links?.length, 1);
      assert.equal(child?.preview, undefined);
    }
  }
});

test("links accumulate transactionally, preserve labels on blank/delayed events, and survive restart and archive", t => {
  const f = fixture(t);
  f.emit("prompt", "UserPromptSubmit", { prompt: "Collect context" });
  const chat = f.store.chats()[0];
  f.store.command({ type: "updateChat", id: chat.id, patch: { name: "Mine", notes: "Keep notes", jiraKey: "APP-1", archived: true } });
  f.emit("response", "Stop", { last_assistant_message: "[New label](https://team.example/a)" }, "2026-01-01T00:02:00Z");
  f.emit("old", "Stop", { last_assistant_message: "[Old label](https://team.example/a) https://team.example/b" });
  f.emit("bare", "Stop", { last_assistant_message: "https://team.example/a" }, "2026-01-01T00:03:00Z");
  f.emit("next-prompt", "UserPromptSubmit", { prompt: "Continue" }, "2026-01-01T00:04:00Z");
  const reopened = f.reopen();
  assert.equal(reopened.links().length, 2);
  const link = reopened.links().find(link => link.url.endsWith("/a"))!;
  assert.equal(link.label, "New label");
  assert.equal(link.firstSeenAt, "2026-01-01T00:00:00.000Z");
  assert.equal(link.lastSeenAt, "2026-01-01T00:03:00.000Z");
  assert.equal(f.emit("response", "Stop", { last_assistant_message: "[Changed](https://team.example/a)" }), false);
  assert.equal(reopened.link(link.id).label, "New label");
  assert.equal(reopened.chat(chat.id).jiraKey, "APP-1");
  assert.equal(reopened.chat(chat.id).notes, "Keep notes");
  assert.equal(reopened.chat(chat.id).archived, true);
  reopened.db.exec("CREATE TRIGGER block_link BEFORE INSERT ON chat_links BEGIN SELECT RAISE(ABORT,'storage failure'); END;");
  assert.throws(() => f.emit("retry", "Stop", { last_assistant_message: "https://team.example/c" }), /storage failure/);
  assert.equal(reopened.db.prepare("SELECT 1 FROM processed_events WHERE eventId='retry'").get(), undefined);
  reopened.db.exec("DROP TRIGGER block_link;");
  assert.equal(f.emit("retry", "Stop", { last_assistant_message: "https://team.example/c" }), true);
});

test("v7 migration backs up once, preserves records, and isolates rule settings", t => {
  const f = fixture(t);
  f.emit("prompt", "UserPromptSubmit");
  const before = f.store.chats();
  f.store.db.exec("DROP TABLE background_snapshots; DROP TABLE chat_links; PRAGMA user_version=7;");
  f.reopen();
  assert.deepEqual(f.store.chats(), before);
  assert.deepEqual(f.store.links(), []);
  assert.deepEqual(f.store.settings().linkRules, []);
  const rules = [{ domain: "team.example", pathPrefix: "/wiki", category: "Documents" }];
  f.store.command({ type: "updateSettings", linkRules: rules });
  f.store.command({ type: "updateSettings", jiraBaseUrl: "https://team.example" });
  assert.deepEqual(f.reopen().settings(), { jiraBaseUrl: "https://team.example", linkRules: rules });
  const backups = readdirSync(f.dir).filter(name => /\.bak-/.test(name));
  assert.equal(backups.length, 1);
  const backup = new Database(join(f.dir, backups[0]), { readonly: true });
  try { assert.equal(backup.pragma("user_version", { simple: true }), 7); } finally { backup.close(); }
  const demo = new Store(join(f.dir, "demo.sqlite"));
  try { assert.deepEqual(demo.settings().linkRules, []); } finally { demo.close(); }
});

test("link retention is bounded without evicting fresh URLs for delayed responses", t => {
  const f = fixture(t);
  f.emit("prompt", "UserPromptSubmit");
  for (let batch = 0; batch < 11; batch++) f.emit(`batch-${batch}`, "Stop", {
    last_assistant_message: Array.from({ length: 100 }, (_, i) => `https://team.example/${batch * 100 + i}`).join(" "),
  }, `2026-01-01T00:${String(batch).padStart(2, "0")}:00Z`);
  assert.equal(f.store.links().length, MAX_CHAT_LINKS);
  assert.equal(f.store.links().some(link => link.url === "https://team.example/0"), false);
  f.emit("delayed", "Stop", { last_assistant_message: "https://team.example/ancient" });
  assert.equal(f.store.links().length, MAX_CHAT_LINKS);
  assert.equal(f.store.links().some(link => link.url.endsWith("/ancient")), false);
});
