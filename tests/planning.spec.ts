import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localPlanDay, nextPlanDay } from "../src/shared/planning";
test("daily cards link broad work, carry notes and chats, and retain human-led Other entries after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-plan-ui-")),
    env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () =>
    electron.launch({
      executablePath: process.env.ACD_PACKAGED_EXECUTABLE,
      args: [
        ...(process.env.ACD_PACKAGED_EXECUTABLE ? [] : [resolve(".")]),
        `--data-dir=${dir}`,
      ],
      env: { ...env, ACD_HTTP_PORT: "0" },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const base = await page.evaluate(() =>
      window.deck.command({
        type: "createChat",
        name: "Implementation chat",
        projectId: null,
      }),
    );
    const chat = base.chats[0];
    await page.evaluate(() =>
      window.deck.command({ type: "createProject", name: "Broader goal" }),
    );
    const day = localPlanDay(),
      next = nextPlanDay(day),
      card = `---\ndate: ${day}\n---\n\n## Coding\n- Deck\n\n## Agentic\n- Research\n\n## Other\n- Review document\n- Ask a colleague`;
    const file = join(base.planning.inbox.path, "today.md");
    writeFileSync(file, card);
    await page
      .getByRole("button", { name: "Today", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: /Plan inbox 1/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Plan inbox 1/ }).click();
    await page
      .getByRole("button", { name: "Review card today.md", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Review items", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Import day plan", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Select plan item Deck", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Work mostly done by you — reviews, conversations, and follow-ups",
      ),
    ).toBeVisible();
    await page
      .getByLabel("Plan item project")
      .selectOption({ label: "Broader goal" });
    await page.getByRole("button", { name: "Edit notes", exact: true }).click();
    await page
      .getByLabel("Plan item notes")
      .fill("## Keep this context\n\nBroad work, no detailed checklist.");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator(".plan-notes h2")).toHaveText(
      "Keep this context",
    );
    await page.getByRole("button", { name: "Link chat", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Implementation chat").check();
    await page.getByRole("button", { name: "Save links", exact: true }).click();
    await page
      .getByRole("button", { name: "Mark worked on", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "✓ Worked on this day", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Carry forward", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Schedule item", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Next planning day", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Mark worked on", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".plan-notes h2")).toHaveText(
      "Keep this context",
    );
    await expect(
      page.getByRole("button", {
        name: "Unlink chat Implementation chat",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit notes", exact: true }).click();
    const continuedNotes =
      "## Keep this context\n\nSaved before importing another day.";
    await page.getByLabel("Plan item notes").fill(continuedNotes);
    await page
      .getByRole("button", { name: "Import card", exact: true })
      .click();
    await page.getByLabel("Card transcription").fill(card.replace(day, next));
    await page
      .getByRole("button", { name: "Review items", exact: true })
      .click();
    const old = await page.evaluate(() => window.deck.load());
    const item = old.planning.items.find((i) => i.name === "Deck")!;
    await page
      .getByRole("dialog")
      .getByLabel("Connect Deck", { exact: true })
      .selectOption(item.id);
    await page
      .getByRole("button", { name: "Import day plan", exact: true })
      .click();
    expect(
      (await page.evaluate(() => window.deck.load())).planning.items.filter(
        (i) => i.name === "Deck",
      ),
    ).toHaveLength(1);
    expect(
      (await page.evaluate(() => window.deck.load())).planning.items.find(
        (i) => i.id === item.id,
      )!.notes,
    ).toBe(continuedNotes);
    expect(
      (await page.evaluate(() => window.deck.load())).chats.find(
        (c) => c.id === chat.id,
      )!.projectId,
    ).toBeNull();
    expect(existsSync(file)).toBe(true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(980, 650),
    );
    await page.screenshot({ path: "test-results/planning-minimum.png" });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const dailyPanel = page.getByRole("region", { name: "Plan items", exact: true });
    await dailyPanel.hover();
    await page.mouse.wheel(0, 1200);
    await expect
      .poll(() => dailyPanel.evaluate((e) => e.scrollTop))
      .toBeGreaterThan(0);
    await expect(
      page.getByRole("button", {
        name: "Select plan item Ask a colleague",
        exact: true,
      }),
    ).toBeInViewport();
    expect(await page.locator(".plan-rail").evaluate((e) => e.scrollTop)).toBe(
      0,
    );
    expect(
      await page.locator(".plan-details").evaluate((e) => e.scrollTop),
    ).toBe(0);
    expect(
      await page
        .locator(".plan-details")
        .evaluate((e) => e.scrollHeight > e.clientHeight),
    ).toBe(true);
    await page.getByRole("button", { name: "View card", exact: true }).click();
    await expect(page.locator(".plan-card-source")).toContainText(
      "Review document",
    );
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Today", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Select plan item Deck", exact: true })
      .click();
    await expect(page.getByLabel("Plan item project")).toHaveValue(
      old.projects[0].id,
    );
    await expect(page.locator(".plan-notes h2")).toHaveText(
      "Keep this context",
    );
    const reopened = await page.evaluate(() => window.deck.load());
    expect(
      reopened.planning.entries.filter((e) => e.itemId === item.id),
    ).toHaveLength(2);
    expect(reopened.planning.inbox.files).toHaveLength(0);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1320, 850),
    );
    await page.screenshot({ path: "test-results/planning-desktop.png" });
    expect(errors).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
