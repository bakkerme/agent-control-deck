import { test, expect } from "./renderer-fixture";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { localPlanDay } from "../src/shared/planning";
test("task links use generic rules, safe opening, reversible removal and persistent inline drafts", async ({
  launchRenderer,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "acd-links-ui-"));
  const launch = () => launchRenderer({ dataDirectory: dir });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const initial = await page.evaluate(() =>
        window.deck.command({
          type: "createSource",
          name: "Link source",
          provider: "claude",
          environment: "native",
        }),
      ),
      source = initial.sources[0];
    let sequence = 0;
    const fileTime = new Date();
    for (const [hook, extra] of [
      ["UserPromptSubmit", { prompt: "Write rollout plan" }],
      [
        "Stop",
        {
          last_assistant_message: `${"x".repeat(600)} [Rollout](https://team.example/wiki/rollout) https://team.example/browse/PAY-142 [<img src=x>](https://example.org/context)`,
        },
      ],
    ] as const) {
      const path = join(
        initial.setups[source.id].inbox,
        `${1000 - ++sequence}.json`,
      );
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          eventId: randomUUID(),
          observedAt: new Date(Date.now() + sequence).toISOString(),
          payload: {
            hook_event_name: hook,
            session_id: "plan",
            cwd: "/work/payments",
            ...extra,
          },
        }),
      );
      utimesSync(path, fileTime, fileTime);
      // Stop intentionally ignores unknown sessions; wait for prompt discovery.
      if (hook === "UserPromptSubmit")
        await expect
          .poll(async () =>
            (await page.evaluate(() => window.deck.load())).chats.some(
              (c) => c.externalId === "plan",
            ),
          )
          .toBe(true);
    }
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.deck.load())).links.length,
      )
      .toBe(3);
    const snapshot = await page.evaluate(
        (day) =>
          window.deck.command({
            type: "createPlanItem",
            name: "Release",
            category: "Coding",
            day,
          }),
        localPlanDay(),
      ),
      item = snapshot.planning.items[0];
    await page.evaluate(
      ({ id, chatIds }) =>
        window.deck.command({ type: "setPlanChats", id, chatIds }),
      { id: item.id, chatIds: [snapshot.chats[0].id] },
    );
    await page
      .getByRole("button", { name: "Select task Release", exact: true })
      .click();
    const tracked = () =>
      page.getByRole("region", { name: "Tracked links", exact: true });
    await expect(tracked().getByRole("link")).toHaveCount(3);
    await expect(tracked().locator("img,script")).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    for (const [index, path, category] of [
      [1, "/wiki", "Documents"],
      [2, "/browse", "Tickets"],
    ] as const) {
      await page
        .getByRole("button", { name: "Add category rule", exact: true })
        .click();
      await page.getByLabel(`Rule ${index} domain`).fill("team.example");
      await page.getByLabel(`Rule ${index} path prefix`).fill(path);
      await page.getByLabel(`Rule ${index} category`).fill(category);
    }
    await page
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(page.locator(".settings-save").getByRole("status")).toHaveText("Saved");
    await page.getByLabel("Rule 1 category").fill("Docs");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(
      tracked().getByRole("button", { name: "Docs", exact: true }),
    ).toBeVisible();
    await expect(
      tracked().getByRole("button", { name: "Tickets", exact: true }),
    ).toBeVisible();
    await tracked().getByRole("link", { name: "Rollout", exact: true }).click();
    await expect
      .poll(() => app.openedUrls())
      .toEqual(["https://team.example/wiki/rollout"]);
    await expect(
      page.evaluate(
        (id) => window.deck.openPlanLink(id, "https://unlinked.example"),
        item.id,
      ),
    ).rejects.toThrow();
    await tracked().getByRole("link", { name: "Rollout", exact: true }).hover();
    await tracked()
      .getByRole("button", { name: "Remove link Rollout", exact: true })
      .click();
    await expect(
      tracked().getByRole("link", { name: "Rollout", exact: true }),
    ).toHaveCount(0);
    await tracked().getByText("Removed links", { exact: true }).click();
    await tracked()
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await expect(
      tracked().getByRole("link", { name: "Rollout", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Link URL", exact: true }).click();
    await page
      .getByRole("form", { name: "Edit task link" })
      .getByLabel("URL", { exact: true })
      .fill("https://example.com/manual");
    await page
      .getByRole("form", { name: "Edit task link" })
      .getByLabel("Label (optional)")
      .fill("Manual reference");
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page
      .getByRole("button", { name: "Select task Release", exact: true })
      .click();
    await expect(
      page
        .getByRole("form", { name: "Edit task link" })
        .getByLabel("URL", { exact: true }),
    ).toHaveValue("https://example.com/manual");
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Select task Release", exact: true })
      .click();
    await expect(
      page
        .getByRole("form", { name: "Edit task link" })
        .getByLabel("URL", { exact: true }),
    ).toHaveValue("https://example.com/manual");
    await page.getByRole("button", { name: "Save link", exact: true }).click();
    await tracked()
      .getByRole("link", { name: "Manual reference", exact: true })
      .hover();
    const removeManualLink = tracked().getByRole("button", {
      name: "Remove link Manual reference",
      exact: true,
    });
    // Focus keeps the removal controls available while clicking after restart.
    await removeManualLink.focus();
    await removeManualLink.click();
    await tracked().getByText("Removed links", { exact: true }).click();
    await tracked()
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await expect(
      tracked().getByRole("link", { name: "Manual reference", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Edit task notes", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Task notes", exact: true })
      .fill("Unfinished task note");
    await page.locator(".task-chat-open").click();
    await page
      .getByRole("button", { name: "View chat history", exact: true })
      .click();
    await page
      .locator(".repository-linked-tasks")
      .getByRole("button", { name: "Release", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Task notes", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Edit task notes", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Task notes", exact: true }),
    ).toHaveValue("Unfinished task note");
    await page.getByRole("button", { name: "Save notes", exact: true }).click();
    await page
      .getByRole("button", { name: "Link ticket", exact: true })
      .click();
    const tickets = page.getByRole("form", { name: "Edit task ticket" });
    await tickets
      .getByLabel("Ticket number or URL", { exact: true })
      .fill("https://tickets.example/DECK-99");
    await tickets.getByLabel("Status (optional)").fill("Review");
    await tickets.getByLabel("Ticket note (optional)").fill("Check the layout");
    await tickets
      .getByRole("button", { name: "Save ticket", exact: true })
      .click();
    const ticket = page
      .getByRole("region", { name: "Linked tickets" })
      .getByRole("link", {
        name: "https://tickets.example/DECK-99",
        exact: true,
      });
    await ticket.click();
    await expect
      .poll(() => app.openedUrls())
      .toEqual(["https://tickets.example/DECK-99"]);
    await ticket.hover();
    await page
      .getByRole("button", {
        name: "Edit ticket https://tickets.example/DECK-99",
        exact: true,
      })
      .click();
    await expect(tickets.getByLabel("Status (optional)")).toHaveValue("Review");
    await tickets.getByLabel("Ticket note (optional)").fill("Edited context");
    await tickets
      .getByRole("button", { name: "Save ticket", exact: true })
      .click();
    await ticket.hover();
    await page
      .getByRole("button", {
        name: "Remove ticket https://tickets.example/DECK-99",
        exact: true,
      })
      .click();
    await expect(ticket).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByLabel("Rule 1 category")).toHaveValue("Docs");
    await page
      .getByRole("button", { name: "Add category rule", exact: true })
      .click();
    await page.getByLabel("Rule 3 domain").fill("https://bad.example");
    await page.getByLabel("Rule 3 category").fill("Bad");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Rule 3:" })).toBeVisible();
    await page
      .getByRole("button", { name: "Remove rule 3", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
