import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { organizationField } from "./ui-helpers";
import { randomUUID } from "node:crypto";

test("visible naming and organization controls persist; native input lamps clear on archive and resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-organization-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  const launch = () => electron.launch({ executablePath: process.env.ACD_PACKAGED_EXECUTABLE, args: [...(process.env.ACD_PACKAGED_EXECUTABLE ? [] : [resolve(".")]), `--data-dir=${dir}`], env: { ...env, ACD_HTTP_PORT: "0" } });
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
    // Capture actual OS icon updates without introducing test-only IPC into the app.
    await app.evaluate(({ app, BrowserWindow }) => {
      const icons: string[] = [];
      (globalThis as unknown as { inputIcons: string[] }).inputIcons = icons;
      if (process.platform === "darwin") {
        const original = app.dock!.setIcon.bind(app.dock);
        app.dock!.setIcon = image => { icons.push(typeof image === "string" ? image : image.toDataURL()); original(image); };
      } else if (process.platform === "win32") {
        const window = BrowserWindow.getAllWindows()[0];
        const original = window.setOverlayIcon.bind(window);
        window.setOverlayIcon = (image, description) => { icons.push(image ? image.toDataURL() : "clear"); original(image, description); };
      }
    });
    const icons = () => app.evaluate(() => (globalThis as unknown as { inputIcons: string[] }).inputIcons);
    await (await organizationField(page, "Manual state")).selectOption("waiting");
    await expect(page.getByRole("status")).toHaveText("Saved");
    if (process.platform === "darwin" || process.platform === "win32") await expect.poll(async () => (await icons()).length).toBe(1);
    await page.getByRole("button", { name: /^No project 0$/ }).click();
    // Filtering the waiting chat out or viewing another page must not clear the lamp.
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    if (process.platform === "darwin" || process.platform === "win32") expect((await icons()).length).toBe(1);
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await organization.getByRole("button", { name: "Archive chat", exact: true }).click();
    if (process.platform === "darwin" || process.platform === "win32") {
      await expect.poll(async () => (await icons()).length).toBe(2);
      expect((await icons())[0]).not.toBe((await icons())[1]);
    }
    await organization.getByRole("button", { name: "Restore chat", exact: true }).click();
    await (await organizationField(page, "Manual state")).selectOption("running");
    await expect(page.getByRole("status")).toHaveText("Saved");
    if (process.platform === "darwin" || process.platform === "win32") {
      await expect.poll(async () => (await icons()).length).toBe(4);
      expect((await icons())[0]).toBe((await icons())[2]);
      expect((await icons())[1]).toBe((await icons())[3]);
      writeFileSync("test-results/input-lamp.png", Buffer.from((await icons())[0].split(",")[1], "base64"));
    }
    // The durable inbox must update the native indicator even while the chat is filtered out.
    const sourceSnapshot = await page.evaluate(() => window.deck.command({ type: "createSource", name: "Input source", provider: "claude", environment: "native" }));
    const source = sourceSnapshot.sources[0];
    const emit = (event: string, extra: Record<string, unknown> = {}) => writeFileSync(join(sourceSnapshot.setups[source.id].inbox, `${randomUUID()}.json`), JSON.stringify({ version: 1, eventId: randomUUID(), payload: { hook_event_name: event, session_id: "waiting-chat", cwd: "/work/elsewhere", ...extra } }));
    emit("UserPromptSubmit", { prompt: "A live task" });
    await expect.poll(async () => (await page.evaluate(() => window.deck.load())).chats.find(c => c.externalId === "waiting-chat")?.state).toBe("running");
    emit("Notification", { notification_type: "permission_prompt", message: "Needs input in Claude" });
    await expect.poll(async () => (await page.evaluate(() => window.deck.load())).chats.find(c => c.externalId === "waiting-chat")?.state).toBe("waiting");
    if (process.platform === "darwin" || process.platform === "win32") await expect.poll(async () => (await icons()).length).toBe(5);
    emit("UserPromptSubmit", { prompt: "Continue" });
    await expect.poll(async () => (await page.evaluate(() => window.deck.load())).chats.find(c => c.externalId === "waiting-chat")?.state).toBe("running");
    if (process.platform === "darwin" || process.platform === "win32") await expect.poll(async () => (await icons()).length).toBe(6);
    await page.getByRole("button", { name: "Try demo", exact: true }).click();
    if (process.platform === "darwin" || process.platform === "win32") await expect.poll(async () => (await icons()).length).toBe(7);
    await page.getByRole("button", { name: "Leave demo", exact: true }).click();
    if (process.platform === "darwin" || process.platform === "win32") await expect.poll(async () => (await icons()).length).toBe(8);
    await page.getByRole("button", { name: "Select chat Plan the rollout", exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 650));
    expect(await organization.evaluate(el => { const a = el.getBoundingClientRect(), b = el.closest(".details")!.getBoundingClientRect(); return a.left >= b.left && a.right <= b.right; })).toBe(true);
    await page.screenshot({ path: "test-results/organization-minimum.png" });
    await organization.getByRole("button", { name: "Archive chat", exact: true }).click();
    await app.close();
    app = await launch(); page = await app.firstWindow();
    await page.getByLabel("Show archived chats").check();
    await page.getByRole("button", { name: "Select chat Plan the rollout" }).click();
    await expect(page.getByLabel("Chat details").getByRole("combobox", { name: "Project", exact: true })).toHaveValue((await page.evaluate(() => window.deck.load())).projects.find(p => p.name === "Launch")!.id);
    await expect(page.getByRole("button", { name: "Restore chat", exact: true })).toBeVisible();
    expect((await page.evaluate(() => window.deck.load())).projects.some(p => p.name === "Customer experience")).toBe(true);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
