import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { organizationField } from "./ui-helpers";
import { randomUUID } from "node:crypto";

test("native input lamps clear on archive, provider resume and demo changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-native-lamps-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
    ),
  ) as Record<string, string>;
  const app = await electron.launch({
    executablePath: process.env.ACD_PACKAGED_EXECUTABLE,
    args: [
      ...(process.env.ACD_PACKAGED_EXECUTABLE ? [] : [resolve(".")]),
      `--data-dir=${dir}`,
    ],
    env: { ...env, ACD_HTTP_PORT: "0" },
  });
  try {
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "New chat", exact: true }),
    ).toBeVisible();
    await page.evaluate(async () => {
      const snapshot = await window.deck.command({
        type: "createProject",
        name: "Launch",
      });
      await window.deck.command({
        type: "createChat",
        name: "Plan the rollout",
        projectId: snapshot.projects[0].id,
      });
    });
    await page
      .getByRole("button", { name: "Select chat Plan the rollout" })
      .click();
    const organization = page.getByRole("region", {
      name: "Chat organization",
    });
    // Capture actual OS icon updates without introducing test-only IPC into the app.
    await app.evaluate(({ app, BrowserWindow }) => {
      const icons: string[] = [];
      (globalThis as unknown as { inputIcons: string[] }).inputIcons = icons;
      if (process.platform === "darwin") {
        const original = app.dock!.setIcon.bind(app.dock);
        app.dock!.setIcon = (image) => {
          icons.push(typeof image === "string" ? image : image.toDataURL());
          original(image);
        };
      } else if (process.platform === "win32") {
        const window = BrowserWindow.getAllWindows()[0];
        const original = window.setOverlayIcon.bind(window);
        window.setOverlayIcon = (image, description) => {
          icons.push(image ? image.toDataURL() : "clear");
          original(image, description);
        };
      }
    });
    const icons = () =>
      app.evaluate(
        () => (globalThis as unknown as { inputIcons: string[] }).inputIcons,
      );
    await (
      await organizationField(page, "Manual state")
    ).selectOption("waiting");
    await expect(page.getByRole("status")).toHaveText("Saved");
    if (process.platform === "darwin" || process.platform === "win32")
      await expect.poll(async () => (await icons()).length).toBe(1);
    await page.getByLabel("Search chats").fill("nonmatching filter");
    // Filtering the waiting chat out or viewing another page must not clear the lamp.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings", exact: true }).getByRole("button", { name: "Sources", exact: true }).click();
    if (process.platform === "darwin" || process.platform === "win32")
      expect((await icons()).length).toBe(1);
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    await page.getByLabel("Search chats").fill("");
    await organization
      .getByRole("button", { name: "Archive chat", exact: true })
      .click();
    if (process.platform === "darwin" || process.platform === "win32") {
      await expect.poll(async () => (await icons()).length).toBe(2);
      expect((await icons())[0]).not.toBe((await icons())[1]);
    }
    await organization
      .getByRole("button", { name: "Restore chat", exact: true })
      .click();
    await (
      await organizationField(page, "Manual state")
    ).selectOption("running");
    await expect(page.getByRole("status")).toHaveText("Saved");
    if (process.platform === "darwin" || process.platform === "win32") {
      await expect.poll(async () => (await icons()).length).toBe(4);
      expect((await icons())[0]).toBe((await icons())[2]);
      expect((await icons())[1]).toBe((await icons())[3]);
      writeFileSync(
        "test-results/input-lamp.png",
        Buffer.from((await icons())[0].split(",")[1], "base64"),
      );
    }
    // The durable inbox must update the native indicator even while the chat is filtered out.
    const sourceSnapshot = await page.evaluate(() =>
      window.deck.command({
        type: "createSource",
        name: "Input source",
        provider: "claude",
        environment: "native",
      }),
    );
    const source = sourceSnapshot.sources[0];
    const emit = (event: string, extra: Record<string, unknown> = {}) =>
      writeFileSync(
        join(sourceSnapshot.setups[source.id].inbox, `${randomUUID()}.json`),
        JSON.stringify({
          version: 1,
          eventId: randomUUID(),
          payload: {
            hook_event_name: event,
            session_id: "waiting-chat",
            cwd: "/work/elsewhere",
            ...extra,
          },
        }),
      );
    emit("UserPromptSubmit", { prompt: "A live task" });
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.deck.load())).chats.find(
            (c) => c.externalId === "waiting-chat",
          )?.state,
      )
      .toBe("running");
    emit("Notification", {
      notification_type: "permission_prompt",
      message: "Needs input in Claude",
    });
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.deck.load())).chats.find(
            (c) => c.externalId === "waiting-chat",
          )?.state,
      )
      .toBe("waiting");
    if (process.platform === "darwin" || process.platform === "win32")
      await expect.poll(async () => (await icons()).length).toBe(5);
    // Answering Claude's question resumes a tool without submitting a prompt.
    emit("PostToolUse", {
      tool_name: "AskUserQuestion",
      tool_response: { answers: { "Continue?": "Yes" } },
    });
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.deck.load())).chats.find(
            (c) => c.externalId === "waiting-chat",
          )?.state,
      )
      .toBe("running");
    if (process.platform === "darwin" || process.platform === "win32")
      await expect.poll(async () => (await icons()).length).toBe(6);
    await page.evaluate(() => window.deck.command({ type: "setDemo", enabled: true }));
    if (process.platform === "darwin" || process.platform === "win32")
      await expect.poll(async () => (await icons()).length).toBe(7);
    await page.evaluate(() => window.deck.command({ type: "setDemo", enabled: false }));
    if (process.platform === "darwin" || process.platform === "win32")
      await expect.poll(async () => (await icons()).length).toBe(8);
    // A live request lights the native indicator before any observed chat exists.
    const responseSetup = await page.evaluate(id => window.deck.command({ type: "setSourceResponses", id, enabled: true }), source.id);
    const hook = JSON.parse(responseSetup.setups[source.id].config).hooks.PermissionRequest[0].hooks[0];
    const decision = fetch(hook.url, { method: "POST", headers: { ...hook.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "not-discovered", tool_name: "Bash", tool_input: { command: "git status" } }) }).then(r => r.json());
    const permission = page.getByRole("dialog", { name: "Permission request" });
    await expect(permission).toBeVisible();
    await expect(permission.getByRole("button", { name: "Keep waiting" })).toBeFocused();
    if (process.platform === "darwin" || process.platform === "win32") await expect.poll(async () => (await icons()).length).toBe(9);
    await permission.getByRole("button", { name: "Allow once" }).click();
    expect((await decision).hookSpecificOutput.decision.behavior).toBe("allow");
    await expect(permission).toHaveCount(0);
    if (process.platform === "darwin" || process.platform === "win32") await expect.poll(async () => (await icons()).length).toBe(10);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
