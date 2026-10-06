import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

test("sidebar priority flags highlight actionable chats across filters and persist with pencil renames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-priority-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  const launch = () => electron.launch({ executablePath: process.env.ACD_PACKAGED_EXECUTABLE, args: [...(process.env.ACD_PACKAGED_EXECUTABLE ? [] : [resolve(".")]), `--data-dir=${dir}`], env: { ...env, ACD_HTTP_PORT: "0" } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const initial = await page.evaluate(() => window.deck.command({ type: "createSource", name: "Priority Claude", provider: "claude", environment: "native" }));
    const source = initial.sources[0];
    let sequence = 0;
    const base = Date.now();
    const emit = (hook: string, session = "priority", extra: Record<string, unknown> = {}) => writeFileSync(
      join(initial.setups[source.id].inbox, `${randomUUID()}.json`),
      JSON.stringify({ version: 1, eventId: randomUUID(), observedAt: new Date(base + ++sequence).toISOString(), payload: {
        hook_event_name: hook, session_id: session, cwd: session === "other" ? "/work/other" : "/work/priority-repo", ...extra,
      } }),
    );
    emit("UserPromptSubmit", "priority", { prompt: "Release task" });
    emit("UserPromptSubmit", "other", { prompt: "Other task" });
    const task = () => page.getByRole("button", { name: "Select chat Release task", exact: true });
    const sidebar = () => page.locator(".projects");
    const repoFlag = () => sidebar().getByRole("button", { name: "Priority project priority-repo", exact: true });
    const repoRow = () => sidebar().locator(".project-row").filter({ has: page.getByRole("button", { name: "Priority project priority-repo", exact: true }) });
    await expect(task()).toBeVisible();
    await expect(repoFlag()).toHaveAttribute("aria-pressed", "false");
    await repoFlag().focus();
    await page.keyboard.press("Space");
    await expect(repoFlag()).toHaveAttribute("aria-pressed", "true");
    await expect(task()).not.toHaveClass(/priority-attention/);
    await expect(repoRow().locator(".priority-lamp")).toHaveCount(0);
    await expect(repoRow().getByRole("button", { name: "Rename project priority-repo", exact: true })).toBeVisible();

    emit("SubagentStart", "priority", { agent_id: "worker", agent_type: "Explore" });
    emit("Stop", "priority", { last_assistant_message: "Parent finished" });
    await expect(task().locator(".status")).toHaveText(/Main turn finished/);
    await expect(task()).not.toHaveClass(/priority-attention/);
    emit("SubagentStop", "priority", { agent_id: "worker" });
    await expect(task()).toHaveClass(/priority-attention/);
    await expect(task().locator(".priority-caption")).toHaveText("Priority · Turn finished");
    await expect(repoRow().locator(".priority-lamp")).toBeVisible();
    await expect(repoRow().getByRole("button", { name: /^priority-repo 1$/ })).toHaveAttribute("aria-description", /1 chat finished/);
    await expect(page.getByRole("button", { name: "Select chat Other task", exact: true })).not.toHaveClass(/priority-attention/);
    await page.getByRole("button", { name: /^other 1$/ }).click();
    await expect(task()).toHaveCount(0);
    await expect(repoRow().locator(".priority-lamp")).toBeVisible();
    await page.getByRole("button", { name: /^All projects 2$/ }).click();

    const snapshot = await page.evaluate(() => window.deck.load());
    const chat = snapshot.chats.find(c => c.externalId === "priority")!;
    emit("Notification", "priority", { notification_type: "permission_prompt", message: "Needs input" });
    await expect(task().locator(".priority-caption")).toHaveText("Priority · Needs input");
    await task().click();
    await page.screenshot({ path: "test-results/project-priority.png" });
    await sidebar().getByRole("button", { name: "+ Add a new project", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Project name", { exact: true }).fill("Release planning");
    await page.getByRole("dialog").getByRole("button", { name: "Create project", exact: true }).click();
    await sidebar().getByRole("button", { name: "Rename project Release planning", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Project name", { exact: true }).fill("Release review");
    await page.getByRole("dialog").getByRole("button", { name: "Save name", exact: true }).click();
    const customFlag = () => sidebar().getByRole("button", { name: "Priority project Release review", exact: true });
    await customFlag().click();
    await expect(customFlag()).toHaveAttribute("aria-pressed", "true");
    const custom = (await page.evaluate(() => window.deck.load())).projects.find(p => p.name === "Release review")!;
    await page.evaluate(({ id, projectId }) => window.deck.command({ type: "updateChat", id, patch: { projectId } }), { id: chat.id, projectId: custom.id });
    await expect(task()).toHaveClass(/priority-attention/);
    await repoFlag().click();
    await expect(repoFlag()).toHaveAttribute("aria-pressed", "false");
    await expect(task()).toHaveClass(/priority-attention/);
    await page.screenshot({ path: "test-results/project-priority-custom.png" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 650));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(980);
    await expect.poll(() => sidebar().evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll("button")).every(button => {
        const box = button.getBoundingClientRect();
        return box.left >= bounds.left && box.right <= bounds.right;
      });
    })).toBe(true);
    await page.screenshot({ path: "test-results/project-priority-minimum.png" });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.on("pageerror", error => errors.push(error.message));
    await expect(customFlag()).toHaveAttribute("aria-pressed", "true");
    await expect(repoFlag()).toHaveAttribute("aria-pressed", "false");
    await expect(task()).toHaveClass(/priority-attention/);
    emit("UserPromptSubmit", "priority", { prompt: "Release task" });
    await expect(task().locator(".status")).toHaveText("Running");
    await expect(task()).not.toHaveClass(/priority-attention/);
    await expect(sidebar().locator(".priority-lamp")).toHaveCount(0);
    emit("SessionEnd");
    await expect(task().locator(".priority-caption")).toHaveText("Priority · Session ended");
    await page.evaluate(id => window.deck.command({ type: "updateChat", id, patch: { archived: true } }), chat.id);
    await expect(sidebar().locator(".priority-lamp")).toHaveCount(0);
    await page.getByRole("button", { name: /^Archived chats 1$/ }).click();
    await expect(task()).not.toHaveClass(/priority-attention/);
    await page.evaluate(id => window.deck.command({ type: "updateChat", id, patch: { archived: false } }), chat.id);
    await page.getByRole("button", { name: /^Active chats 2$/ }).click();
    await expect(task()).toHaveClass(/priority-attention/);
    await customFlag().click();
    await expect(customFlag()).toHaveAttribute("aria-pressed", "false");
    await expect(task()).not.toHaveClass(/priority-attention/);
    expect(errors).toEqual([]);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
