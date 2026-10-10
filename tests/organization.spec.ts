import { test, expect } from "./renderer-fixture";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { organizationField } from "./ui-helpers";
import { randomUUID } from "node:crypto";

test("visible naming and organization controls persist across archive and resume", async ({ launchRenderer }) => {
  const dir = mkdtempSync(join(tmpdir(), "acd-organization-"));
  const launch = () => launchRenderer({ dataDirectory: dir });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.evaluate(async () => {
      await window.deck.command({ type: "createProject", name: "folder-name" });
      const snapshot = await window.deck.command({ type: "createProject", name: "Launch" });
      await window.deck.command({ type: "createChat", projectId: snapshot.projects.find(p => p.name === "folder-name")!.id, name: "Original chat" });
    });
    await page.getByRole("button", { name: "Select chat Original chat" }).click();
    const organization = page.getByRole("region", { name: "Chat organization" });
    await expect(organization.getByLabel("Chat name", { exact: true })).toBeInViewport();
    await expect(organization.getByRole("button", { name: "Archive chat" })).toBeInViewport();
    await organization.getByLabel("Chat name", { exact: true }).fill("Plan the rollout");
    // Renaming must use the chat's project even when the project filter is All.
    await organization.getByRole("button", { name: "Rename project", exact: true }).click();
    await expect(page.getByRole("dialog").getByLabel("Project name", { exact: true })).toHaveValue("folder-name");
    await page.getByRole("dialog").getByLabel("Project name", { exact: true }).fill("Customer experience");
    await page.getByRole("dialog").getByRole("button", { name: "Save name", exact: true }).click();
    await expect(organization.getByRole("combobox", { name: "Project", exact: true })).toHaveValue((await page.evaluate(() => window.deck.load())).projects.find(p => p.name === "Customer experience")!.id);
    await expect(page.getByRole("button", { name: "Select chat Plan the rollout" })).toContainText("Customer experience");
    await organization.getByRole("combobox", { name: "Project", exact: true }).selectOption({ label: "Launch" });
    await expect(page.getByRole("status")).toHaveText("Saved");
    await (await organizationField(page, "Manual state")).selectOption("waiting");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await page.getByRole("button", { name: /^No project 0$/ }).click();
    // Organization controls stay usable when the chat is filtered out.
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await organization.getByRole("button", { name: "Archive chat", exact: true }).click();
    await organization.getByRole("button", { name: "Restore chat", exact: true }).click();
    await (await organizationField(page, "Manual state")).selectOption("running");
    await expect(page.getByRole("status")).toHaveText("Saved");
    // The durable inbox must update state even while the chat is filtered out.
    const sourceSnapshot = await page.evaluate(() => window.deck.command({ type: "createSource", name: "Input source", provider: "claude", environment: "native" }));
    const source = sourceSnapshot.sources[0];
    const emit = (event: string, extra: Record<string, unknown> = {}) => writeFileSync(join(sourceSnapshot.setups[source.id].inbox, `${randomUUID()}.json`), JSON.stringify({ version: 1, eventId: randomUUID(), payload: { hook_event_name: event, session_id: "waiting-chat", cwd: "/work/elsewhere", ...extra } }));
    emit("UserPromptSubmit", { prompt: "A live task" });
    await expect.poll(async () => (await page.evaluate(() => window.deck.load())).chats.find(c => c.externalId === "waiting-chat")?.state).toBe("running");
    emit("Notification", { notification_type: "permission_prompt", message: "Needs input in Claude" });
    await expect.poll(async () => (await page.evaluate(() => window.deck.load())).chats.find(c => c.externalId === "waiting-chat")?.state).toBe("waiting");
    // Answering Claude's question resumes a tool without submitting a prompt.
    emit("PostToolUse", { tool_name: "AskUserQuestion", tool_response: { answers: { "Continue?": "Yes" } } });
    await expect.poll(async () => (await page.evaluate(() => window.deck.load())).chats.find(c => c.externalId === "waiting-chat")?.state).toBe("running");
    await page.getByRole("button", { name: "Try demo", exact: true }).click();
    await page.getByRole("button", { name: "Leave demo", exact: true }).click();
    await page.getByRole("button", { name: "Select chat Plan the rollout", exact: true }).click();
    await app.resize(980, 650);
    expect(await organization.evaluate(el => { const a = el.getBoundingClientRect(), b = el.closest(".details")!.getBoundingClientRect(); return a.left >= b.left && a.right <= b.right; })).toBe(true);
    await page.screenshot({ path: "test-results/organization-minimum.png" });
    await organization.getByRole("button", { name: "Archive chat", exact: true }).click();
    await app.close();
    app = await launch(); page = await app.firstWindow();
    await page.getByRole("button", { name: /^Archived chats \d+$/ }).click();
    await page.getByRole("button", { name: "Select chat Plan the rollout" }).click();
    await expect(page.getByLabel("Chat details").getByRole("combobox", { name: "Project", exact: true })).toHaveValue((await page.evaluate(() => window.deck.load())).projects.find(p => p.name === "Launch")!.id);
    await expect(page.getByRole("button", { name: "Restore chat", exact: true })).toBeVisible();
    expect((await page.evaluate(() => window.deck.load())).projects.some(p => p.name === "Customer experience")).toBe(true);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
