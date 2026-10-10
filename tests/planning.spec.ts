import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  localPlanDay,
  nextPlanDay,
  nextBusinessDay,
} from "../src/shared/planning";
test("Today supports the complete physical-card workflow and preserves context across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-task-ui-")),
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
    const day = localPlanDay(),
      next = nextPlanDay(day);
    await expect(
      page.getByRole("heading", { name: "Your daily workspace" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Plan inbox/ })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "Plan existing task", exact: true }),
    ).toHaveCount(0);
    const initial = await page.evaluate(() =>
      window.deck.command({
        type: "createSource",
        name: "Local Claude",
        provider: "claude",
        environment: "native",
      }),
    );
    const source = initial.sources[0],
      config = JSON.parse(initial.setups[source.id].config);
    const emit = async (event: string, extra: Record<string, unknown> = {}) => {
      const hook = config.hooks[event][0].hooks[0],
        reply = await fetch(hook.url, {
          method: "POST",
          headers: { ...hook.headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            hook_event_name: event,
            session_id: "ui-design",
            cwd: "/work/deck",
            ...extra,
          }),
        });
      expect(reply.status).toBe(200);
    };
    await emit("UserPromptSubmit", { prompt: "Review the task workspace" });
    await emit("Notification", {
      notification_type: "permission_prompt",
      message: "Allow reading the generated report? No changes will be made.",
    });
    await page
      .getByRole("button", { name: "Import card", exact: true })
      .click();
    const card = `date: ${day}\ncoding:\n  - name: Deck\n    tickets: [DECK-42]\n    note: Review the design\n  - Second coding task\nagentic:\n  - Research\nother:\n  - Review document\n  - Ask a colleague\n`;
    await page.getByLabel("Card text", { exact: true }).fill(card);
    await page
      .getByRole("button", { name: "Review card", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Import card", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Select task Deck", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.deck.load())).chats.some(
          (c) => c.externalId === "ui-design",
        ),
      )
      .toBe(true);
    const plans = await page.evaluate(() => window.deck.load()),
      item = plans.planning.items.find((i) => i.name === "Deck")!,
      chat = plans.chats.find((c) => c.externalId === "ui-design")!;
    await page.getByRole("button", { name: "Link chat", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Review the task workspace")
      .check();
    await page.getByRole("button", { name: "Save links", exact: true }).click();
    await page.locator(".task-chat-open").click();
    await expect(
      page.getByRole("heading", { name: "Approval request", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Input request")).toContainText(
      "Allow reading the generated report?",
    );
    await expect(
      page.getByRole("navigation", { name: "Repositories", exact: true }),
    ).toHaveCount(0);
    await emit("PostToolUse");
    await emit("Notification", {
      notification_type: "elicitation_dialog",
      message: "Should multiple linked chats stay expanded?",
    });
    await expect(
      page.getByRole("heading", { name: "Question for you", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "View chat history", exact: true })
      .click();
    await expect(
      page.getByRole("navigation", { name: "Repositories", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Back to Today", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Question for you", exact: true }),
    ).toBeVisible();
    const note =
      "## Keep this context\n\n**Saved** notes, not an automatic checklist.\n\n<script>alert(1)</script>\n![Remote](https://example.com/image.png)";
    await page
      .getByRole("button", { name: "Edit task notes", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Task notes", exact: true })
      .fill(note);
    expect(
      (await page.evaluate(() => window.deck.load())).planning.items.find(
        (i) => i.id === item.id,
      )!.notes,
    ).toBe("Review the design");
    await page.getByRole("button", { name: "Save notes", exact: true }).click();
    await expect(page.locator(".task-note-display h2")).toHaveText(
      "Keep this context",
    );
    await expect(
      page.locator(".task-note-display script,.task-note-display img"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Save notes", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Link URL", exact: true }).click();
    const linkForm = page.getByRole("form", { name: "Edit task link" });
    await linkForm
      .getByLabel("URL", { exact: true })
      .fill("https://example.com/design");
    await linkForm.getByLabel("Label (optional)").fill("Design notes");
    await linkForm.getByLabel("Category", { exact: true }).selectOption("new");
    await linkForm.getByLabel("New category name").fill("Design");
    await linkForm
      .getByRole("button", { name: "Save link", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Design notes", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Design", exact: true }).click();
    await page.getByLabel("Category name", { exact: true }).fill("References");
    await page
      .locator(".category-inline-edit")
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "References", exact: true }),
    ).toBeVisible();
    const first = page.getByRole("button", {
      name: "Select task Deck",
      exact: true,
    });
    await first.press("Alt+ArrowDown");
    expect(
      (await page.evaluate(() => window.deck.load())).planning.entries
        .filter((e) => e.day === day && e.category === "Coding")
        .map((e) => e.name),
    ).toEqual(["Second coding task", "Deck"]);
    await first.hover();
    const from = await first.boundingBox(),
      other = await page.locator('[data-card-category="Other"]').boundingBox();
    await page.mouse.move(from!.x + 40, from!.y + 20);
    await page.mouse.down();
    await page.mouse.move(other!.x + 30, other!.y + other!.height - 8, {
      steps: 10,
    });
    await page.mouse.up();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.deck.load())).planning.entries.find(
            (e) => e.day === day && e.itemId === item.id,
          )!.category,
      )
      .toBe("Other");
    await page
      .getByRole("button", { name: "Select task Deck", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Mark as done", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "✓ Done", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Move to another day", exact: true })
      .click();
    await expect(
      page.getByRole("dialog").getByLabel("Day", { exact: true }),
    ).toHaveValue(nextBusinessDay(day));
    await page
      .getByRole("button", { name: "+3 business days", exact: true })
      .click();
    await expect(
      page.getByRole("dialog").getByLabel("Day", { exact: true }),
    ).toHaveValue(nextBusinessDay(day, 3));
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Wrap up day", exact: true })
      .click();
    await page
      .getByLabel("Day wrap-up", { exact: true })
      .fill(
        "## For tomorrow\nStart with Slack and reminders, then review both card sides.",
      );
    await page
      .getByRole("button", { name: "Save wrap-up", exact: true })
      .click();
    await expect(
      page
        .getByLabel("Card back")
        .getByRole("heading", { name: "For tomorrow", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Back to tasks", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Import card", exact: true })
      .click();
    await page
      .getByLabel("Card text", { exact: true })
      .fill(
        `# ${next}\n\n## Coding\n- Resolve deck design questions\n  Ask what still needs simplifying.\n\n## Other\n- Follow up after Slack`,
      );
    await page
      .getByRole("button", { name: "Review card", exact: true })
      .click();
    await expect(page.getByLabel("Card front")).toContainText("Deck");
    await expect(page.getByLabel("Card back")).toContainText(
      "Start with Slack",
    );
    await page
      .getByLabel("Task context 1", { exact: true })
      .selectOption(item.id);
    await page
      .getByLabel("Title on card 1", { exact: true })
      .fill("Resolve remaining deck questions");
    await page
      .getByRole("button", { name: "Back to Today", exact: true })
      .click();
    await page.getByRole("button", { name: "+ Add task", exact: true }).click();
    const form = page.getByRole("form", { name: "Create a new task" });
    await form
      .getByLabel("Task name", { exact: true })
      .fill("Handwritten follow-up");
    await form
      .getByLabel("Task category", { exact: true })
      .selectOption("Other");
    await form.getByLabel("Notes (optional)").fill("Context from reminders");
    await page
      .getByLabel("Search existing tasks", { exact: true })
      .fill("Research");
    await expect(form.getByLabel("Task name", { exact: true })).toHaveValue(
      "Handwritten follow-up",
    );
    await expect(page.locator(".existing-task-choice")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Close task form", exact: true })
      .click();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole("button", { name: "+ Add task", exact: true }).click();
    await expect(
      page
        .getByRole("form", { name: "Create a new task" })
        .getByLabel("Task name", { exact: true }),
    ).toHaveValue("Handwritten follow-up");
    await page
      .getByRole("form", { name: "Create a new task" })
      .getByRole("button", { name: "Create task", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Select task Handwritten follow-up",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Resume card review", exact: true })
      .click();
    await expect(
      page.getByLabel("Task context 1", { exact: true }),
    ).toHaveValue(item.id);
    await expect(
      page.getByLabel("Title on card 1", { exact: true }),
    ).toHaveValue("Resolve remaining deck questions");
    await page
      .getByLabel("Task context 2", { exact: true })
      .selectOption(item.id);
    await page
      .getByRole("button", { name: "Import card", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("same plan item");
    await page.getByLabel("Task context 2", { exact: true }).selectOption("");
    await page
      .getByRole("button", { name: "Import card", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Resolve remaining deck questions",
        exact: true,
      }),
    ).toBeVisible();
    const continued = (
      await page.evaluate(() => window.deck.load())
    ).planning.items.find((i) => i.id === item.id)!;
    expect(continued.notes).toBe(note);
    expect(continued.chatIds).toEqual([chat.id]);
    expect(continued.links[0].category).toBe("References");
    expect(
      (await page.evaluate(() => window.deck.load())).planning.entries.find(
        (e) => e.itemId === item.id && e.day === day,
      )!.name,
    ).toBe("Deck");
    await page
      .getByRole("button", { name: `Remove task from ${day}`, exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("button", { name: `Remove task from ${next}`, exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Remove this task?" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    expect(
      (await page.evaluate(() => window.deck.load())).planning.items.some(
        (i) => i.id === item.id,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: `Remove task from ${next}`, exact: true })
      .click();
    await page
      .getByRole("button", { name: "Remove task", exact: true })
      .click();
    expect(
      (await page.evaluate(() => window.deck.load())).planning.items.some(
        (i) => i.id === item.id,
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(
      (await page.evaluate(() => window.deck.load())).planning.items.find(
        (i) => i.id === item.id,
      )!.notes,
    ).toBe(note);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(980, 650),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: "test-results/today-task-workspace-minimum.png",
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1320, 850),
    );
    await page.screenshot({
      path: "test-results/today-task-workspace-desktop.png",
    });
    expect(errors).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
