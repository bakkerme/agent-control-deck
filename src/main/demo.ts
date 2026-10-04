import { randomUUID } from "node:crypto";
import type { Store } from "./store";
export function seedDemo(store: Store): void {
  // Backfill this sample in existing demo databases without resetting edits.
  const time = new Date().toISOString();
  store.db.prepare(`
    INSERT INTO chats (id, projectId, provider, name, notes, state, createdAt, updatedAt)
    VALUES (?, NULL, 'manual', ?, ?, 'idle', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    "demo-unassigned-chat",
    "Explore a standalone idea",
    "A place for ideas that do not belong to a project yet. Choose a project when ready, or keep this chat on its own.",
    time,
    time,
  );
  if (store.projects().length) return;
  store.command({ type: "createProject", name: "Payments API" });
  store.command({ type: "createProject", name: "Customer portal" });
  store.command({
    type: "createSource",
    name: "Demo Claude",
    provider: "claude",
    environment: "native",
  });
  store.command({
    type: "createSource",
    name: "Demo Cursor",
    provider: "cursor",
    environment: "native",
  });
  const claude = store.sources().find((s) => s.provider === "claude")!;
  const cursor = store.sources().find((s) => s.provider === "cursor")!;
  const payments = store.projects().find((p) => p.name === "Payments API")!;
  const portal = store.projects().find((p) => p.name === "Customer portal")!;
  store.command({
    type: "addWorkspace",
    sourceId: claude.id,
    projectId: payments.id,
    path: "/demo/payments",
  });
  store.command({
    type: "addWorkspace",
    sourceId: cursor.id,
    projectId: portal.id,
    path: "/demo/portal",
  });
  store.ingest(claude.id, {
    version: 1,
    eventId: randomUUID(),
    payload: {
      hook_event_name: "UserPromptSubmit",
      session_id: "demo-api",
      cwd: "/demo/payments",
      prompt: "Fix webhook retry handling",
    },
  });
  store.ingest(cursor.id, {
    version: 1,
    eventId: randomUUID(),
    payload: {
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "demo-ui",
      workspace_roots: ["/demo/portal"],
      prompt: "Add empty states to the dashboard",
    },
  });
  store.command({
    type: "createChat",
    projectId: payments.id,
    name: "Investigate settlement mismatch",
  });
  const manual = store.chats().find((c) => c.provider === "manual" && c.projectId === payments.id)!;
  store.command({
    type: "updateChat",
    id: manual.id,
    patch: {
      notes:
        "Compare the reconciliation report with yesterday’s export.\n\nNext: check rounding at the currency boundary.",
      jiraKey: "PAY-142",
      state: "waiting",
    },
  });
}
export function advanceDemo(store: Store): void {
  const chat = store.chats().find((c) => c.externalId === "demo-api");
  if (!chat || !chat.sourceId) return;
  const event =
    chat.state === "running"
      ? {
          hook_event_name: "Notification",
          notification_type: "permission_prompt",
          message: "Waiting for a decision in Claude Code",
        }
      : chat.state === "waiting"
        ? {
            hook_event_name: "Stop",
            last_assistant_message:
              "Retry changes are ready for review. Tests pass.",
          }
        : chat.state === "idle"
          ? { hook_event_name: "StopFailure", error: "Example API failure" }
          : {
              hook_event_name: "UserPromptSubmit",
              prompt: "Retry the webhook tests",
            };
  store.ingest(chat.sourceId, {
    version: 1,
    eventId: randomUUID(),
    payload: { ...event, session_id: "demo-api", cwd: "/demo/payments" },
  });
}
