import { test } from "node:test";
import assert from "node:assert/strict";
import { InputIndicator, inputNeededCount } from "../src/main/attention";
import type { Chat } from "../src/shared/types";

const chat = (patch: Partial<Chat> = {}): Chat => ({
  id: "chat", projectId: null, repoProjectId: null, provider: "claude", sourceId: "source", externalId: "session",
  name: "", providerTitle: "A task", notes: "", jiraKey: "", jiraUrl: "", archived: false,
  state: "waiting", lifecycle: "open", preview: "", lastEventAt: null, createdAt: "", updatedAt: "", subagents: [], backgroundTasks: [], scheduledChecks: [], ...patch,
});

test("only open, unarchived chats waiting for input light the indicator", () => {
  assert.equal(inputNeededCount([
    chat(), chat({ id: "manual", provider: "manual" }),
    chat({ archived: true }), chat({ lifecycle: "ended" }),
    ...(["running", "idle", "error", "unknown"] as const).map(state => chat({ state })),
  ]), 2);
});

test("the indicator remains lit until all waiting chats resume, end, or are archived", () => {
  const calls: number[] = [];
  const indicator = new InputIndicator(count => calls.push(count));
  const first = chat();
  const second = chat({ id: "second", projectId: "other-project" });
  indicator.update([]);
  indicator.update([first, second]);
  indicator.update([first, second]);
  indicator.update([{ ...first, archived: true }, second]);
  indicator.update([{ ...first, archived: true }, { ...second, lifecycle: "ended" }]);
  indicator.update([first]);
  indicator.update([{ ...first, state: "running" }]);
  indicator.update([{ ...first, state: "running" }], true);
  assert.deepEqual(calls, [0, 2, 1, 0, 1, 0, 0]);
});

test("an OS failure can be retried without losing the pending indicator state", () => {
  let failing = true;
  const calls: number[] = [];
  const indicator = new InputIndicator(count => {
    if (failing) throw new Error("OS unavailable");
    calls.push(count);
  });
  assert.throws(() => indicator.update([chat()]));
  failing = false;
  indicator.update([chat()]);
  assert.deepEqual(calls, [1]);
});
