import { test, expect } from "./renderer-fixture";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("archived conversations stay restorable while new chats in the same project remain active", async ({
  launchRenderer,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "acd-archive-"));
  const launch = () => launchRenderer({ dataDirectory: dir });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    const snapshot = await page.evaluate(() =>
      window.deck.command({
        type: "createSource",
        name: "Claude",
        provider: "claude",
        environment: "native",
      }),
    );
    const source = snapshot.sources[0];
    const setup = snapshot.setups[source.id];
    const headers = JSON.parse(setup.config).hooks.UserPromptSubmit[0].hooks[0]
      .headers;
    const emit = async (session: string, prompt: string) => {
      const response = await fetch(`${setup.endpoint}/UserPromptSubmit`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: session,
          cwd: "/work/shared-project",
          prompt,
        }),
      });
      expect(response.status).toBe(200);
    };
    await emit("old-chat", "Original task");
    await page
      .getByRole("button", { name: "Select chat Original task", exact: true })
      .click();
    await page.getByRole("button", { name: /^shared-project 1$/ }).click();
    await page
      .getByRole("button", { name: "Select chat Original task", exact: true })
      .click();
    const organization = page.getByRole("region", {
      name: "Chat organization",
    });
    await organization
      .getByLabel("Chat name", { exact: true })
      .fill("Keep my task");
    await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    await organization
      .getByRole("button", { name: "Archive chat", exact: true })
      .click();
    await page.getByRole("button", { name: /^Active chats 0$/ }).click();
    await expect(
      page.getByRole("button", {
        name: "Select chat Keep my task",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: /^Needs input 0$/ }).click();
    await page.getByLabel("Search chats").fill("nonmatching filter");
    await page.getByLabel("Provider filter").selectOption("cursor");
    await page.getByRole("button", { name: /^Archived chats 1$/ }).click();
    await expect(page.getByLabel("Search chats")).toHaveValue("");
    await expect(page.getByLabel("Provider filter")).toHaveValue("all");
    await expect(
      page.getByRole("button", { name: /^shared-project 1$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Select chat Keep my task",
        exact: true,
      }),
    ).toBeVisible();
    await emit("new-chat", "New task");
    await expect(
      page.getByRole("button", { name: /^Active chats 1$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Select chat New task", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({ path: "test-results/archive-view.png" });
    await page.getByRole("button", { name: /^Active chats 1$/ }).click();
    await expect(
      page.getByRole("button", { name: "Select chat New task", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Select chat Keep my task",
        exact: true,
      }),
    ).toHaveCount(0);
    await emit("old-chat", "Resurrect original conversation");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.deck.load())).chats.find(
            (c) => c.externalId === "old-chat",
          )?.preview,
      )
      .toBe("Resurrect original conversation");
    await page.getByRole("button", { name: /^Archived chats 1$/ }).click();
    await page
      .getByRole("button", { name: "Select chat Keep my task", exact: true })
      .click();
    await organization
      .getByRole("button", { name: "Restore chat", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /^Active chats 2$/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", {
        name: "Select chat Keep my task",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Select chat New task", exact: true }),
    ).toBeVisible();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Select chat Keep my task",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Select chat New task", exact: true }),
    ).toBeVisible();
    const persisted = await page.evaluate(() => window.deck.load());
    const chats = persisted.chats.filter((c) => c.sourceId === source.id);
    expect(chats).toHaveLength(2);
    expect(chats[0].projectId).toBe(chats[1].projectId);
    expect(chats.every((c) => !c.archived)).toBe(true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
