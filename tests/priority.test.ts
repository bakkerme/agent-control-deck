import { test } from "node:test";
import assert from "node:assert/strict";
import type { Chat, Project } from "../src/shared/types";
import { priorityAttention } from "../src/shared/status";

const chat = (patch: Partial<Chat> = {}): Chat => ({
  id: "chat", projectId: "custom", repoProjectId: "repo", provider: "claude", sourceId: "source", externalId: "session",
  name: "", providerTitle: "Task", notes: "", jiraKey: "", jiraUrl: "", archived: false,
  state: "idle", lifecycle: "open", preview: "", lastEventAt: "2026-10-06T00:00:00Z", createdAt: "", updatedAt: "", subagents: [], ...patch,
});
const project = (id: string, priority: boolean): Project => ({ id, name: id, createdAt: "", kind: id === "repo" ? "repo" : "custom", priority });

test("either priority grouping draws attention to finished, waiting, error, and ended chats", () => {
  for (const projects of [[project("repo", true)], [project("custom", true)], [project("repo", true), project("custom", true)]]) {
    assert.equal(priorityAttention(chat(), projects), "Turn finished");
    assert.equal(priorityAttention(chat({ state: "waiting" }), projects), "Needs input");
    assert.equal(priorityAttention(chat({ state: "error" }), projects), "Error");
    assert.equal(priorityAttention(chat({ lifecycle: "ended" }), projects), "Session ended");
  }
  assert.equal(priorityAttention(chat(), [project("repo", false), project("custom", false)]), null);
  assert.equal(priorityAttention(chat(), [project("unrelated", true)]), null);
});

test("priority does not infer completion for running, unobserved, or unfinished subagent work", () => {
  const projects = [project("repo", true)];
  const worker = { id: "child", type: "Explore", state: "running" as const, lastEventAt: "2026-01-01T00:00:00Z" };
  for (const patch of [
    { state: "running" as const }, { state: "unknown" as const }, { archived: true },
    { lastEventAt: null }, { provider: "manual" as const },
    { subagents: [worker] }, { subagents: [{ ...worker, state: "unknown" as const }] },
    { lifecycle: "ended" as const, subagents: [worker] },
  ]) assert.equal(priorityAttention(chat(patch), projects), null);
  // Explicit requests still matter while a child works; archiving removes them.
  assert.equal(priorityAttention(chat({ state: "waiting", subagents: [worker] }), projects), "Needs input");
  assert.equal(priorityAttention(chat({ state: "waiting", archived: true }), projects), null);
});
