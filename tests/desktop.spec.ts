import { test, expect } from "./renderer-fixture";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notesField, organizationField } from "./ui-helpers";
test("Today is primary; repository chats retain manual records, live events, archives and demo isolation", async ({
  launchRenderer,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "acd-desktop-"));
  const launch = () => launchRenderer({ dataDirectory: dir });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("heading", { name: "Your daily workspace" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "+ Add a new project", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(
      page.getByRole("dialog").getByLabel("Repository", { exact: true }),
    ).toHaveValue("");
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .fill("Manual follow-up");
    await page
      .getByRole("button", { name: "Create chat", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Select chat Manual follow-up",
        exact: true,
      }),
    ).toBeVisible();
    await (await notesField(page)).fill("## Persisted manual notes");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await (
      await organizationField(page, "Manual state")
    ).selectOption("waiting");
    await expect(page.locator(".activity-heading .status")).toHaveText(
      "Needs input",
    );
    await page
      .getByRole("button", { name: "Archive chat", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Restore chat", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Chat visibility", exact: true })
      .getByRole("button", { name: /^Active chats/ })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Select chat Manual follow-up",
        exact: true,
      }),
    ).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "Chat visibility", exact: true })
      .getByRole("button", { name: /^Archived chats/ })
      .click();
    await page
      .getByRole("button", {
        name: "Select chat Manual follow-up",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Restore chat", exact: true })
      .click();
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    await page.getByLabel("Source name").fill("Local Claude");
    await page
      .getByRole("button", { name: "Create source", exact: true })
      .click();
    const snapshot = await page.evaluate(() => window.deck.load()),
      source = snapshot.sources[0],
      config = JSON.parse(snapshot.setups[source.id].config);
    const emit = async (event: string, extra: Record<string, unknown> = {}) => {
      const hook = config.hooks[event][0].hooks[0],
        reply = await fetch(hook.url, {
          method: "POST",
          headers: { ...hook.headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            hook_event_name: event,
            session_id: "live",
            cwd: "/work/api",
            ...extra,
          }),
        });
      expect(reply.status).toBe(200);
      expect(await reply.text()).toBe("");
    };
    await emit("UserPromptSubmit", { prompt: "Work on API" });
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    await page.getByRole("button", { name: /^All repositories/ }).click();
    await page
      .getByRole("button", { name: "Select chat Work on API", exact: true })
      .click();
    await (await organizationField(page, "Chat name")).fill("Named live chat");
    await (await notesField(page)).fill("My live notes stay mine");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await emit("Notification", {
      notification_type: "permission_prompt",
      message: "Allow checking tests?",
    });
    await expect(page.locator(".activity-heading .status")).toHaveText(
      "Needs input",
    );
    await emit("PostToolUse");
    await emit("Stop", { last_assistant_message: "## Ready\n\nTests pass" });
    await expect(page.locator(".activity-heading .status")).toHaveText(
      "Turn finished",
    );
    await expect(page.locator(".rendered-notes")).toContainText(
      "My live notes stay mine",
    );
    await page.getByRole("button", { name: "Try demo", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "Select task Customer portal",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Leave demo", exact: true }).click();
    expect(
      (await page.evaluate(() => window.deck.load())).chats.some(
        (c) => c.name === "Named live chat",
      ),
    ).toBe(true);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Select chat Named live chat", exact: true })
      .click();
    await expect(page.locator(".rendered-notes")).toContainText(
      "My live notes stay mine",
    );
    expect(errors).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
