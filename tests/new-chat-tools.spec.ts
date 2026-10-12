import { test, expect } from "./renderer-fixture";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPlanDay } from "../src/shared/planning";

test("Today supports repository chat tools and archiving without creating a task", async ({ launchRenderer }) => {
  const dir = mkdtempSync(join(tmpdir(), "acd-today-chat-tools-"));
  const launch = () => launchRenderer({ dataDirectory: dir, commandReplyDelayMs: 100 });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const state = await page.evaluate(async () => {
      await window.deck.command({ type: "createChat", name: "Second chat to archive", projectId: null });
      await window.deck.command({ type: "updateSettings", jiraBaseUrl: "https://team.example", linkRules: [
        { domain: "team.example", pathPrefix: "/wiki", category: "Docs" },
      ] });
      return window.deck.command({ type: "createSource", name: "Local Claude", provider: "claude", environment: "native" });
    });
    const hooks = JSON.parse(state.setups[state.sources[0].id].config).hooks;
    const emit = async (event: string, extra: Record<string, unknown>) => {
      const hook = hooks[event][0].hooks[0];
      const reply = await fetch(hook.url, {
        method: "POST", headers: { ...hook.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ hook_event_name: event, session_id: "taskless-chat", cwd: "/work/deck", ...extra }),
      });
      expect(reply.status).toBe(200);
    };
    await emit("UserPromptSubmit", { prompt: "Review an unrelated discussion" });
    await emit("Stop", {
      last_assistant_message: `${"Useful context. ".repeat(40)} [Discussion](https://team.example/wiki/discussion)`,
      background_tasks: [],
      session_crons: [{ id: "followup", schedule: "*/10 * * * *", recurring: true, prompt: "Observe follow-up" }],
    });
    const section = page.getByRole("region", { name: "New chats", exact: true });
    await expect(section.locator(".new-chats-count")).toHaveText("2");
    await section.getByRole("button", { name: "Select new chat Review an unrelated discussion", exact: true }).click();
    let details = page.getByRole("region", { name: "Chat details", exact: true });
    await expect(details).toContainText("This chat can stay here without a task.");
    const links = details.getByRole("region", { name: "Chat links", exact: true });
    await expect(links).toContainText("Docs");
    await links.getByRole("button", { name: "Open link Discussion", exact: true }).click();
    await expect.poll(() => app.openedUrls()).toEqual(["https://team.example/wiki/discussion"]);
    await expect(details.locator(".history li")).toHaveCount(2);
    await expect(details.getByLabel("Latest round Review an unrelated discussion")).toContainText("Useful context.");
    await details.getByText("Background work and scheduled checks", { exact: true }).click();
    await expect(details.getByRole("group", { name: "Background observations", exact: true })).toContainText("Recurring · */10 * * * *");
    await details.getByText("Source identity", { exact: true }).click();
    await expect(details.locator(".source-details")).toContainText("taskless-chat");
    await details.getByLabel("Chat name", { exact: true }).fill("Discussion to keep");
    await details.getByRole("button", { name: "Edit notes", exact: true }).click();
    await details.getByLabel("Notes", { exact: true }).fill("**Saved** without a task.\n\n<script>unsafe()</script>");
    await details.getByRole("button", { name: "Done", exact: true }).click();
    await expect(details.locator(".rendered-notes strong")).toHaveText("Saved");
    await expect(details.locator("script,img")).toHaveCount(0);
    await details.getByRole("button", { name: "Add ticket", exact: true }).click();
    await details.getByLabel("Ticket number or full URL").fill("deck-42");
    await details.getByRole("button", { name: "Save ticket", exact: true }).click();
    await details.getByRole("button", { name: "Open Jira ticket DECK-42", exact: true }).click();
    await expect.poll(() => app.openedUrls()).toEqual([
      "https://team.example/wiki/discussion", "https://team.example/browse/DECK-42",
    ]);
    // Both surfaces operate on the same chat, and returning refreshes the editor.
    await details.getByRole("button", { name: "View chat history", exact: true }).click();
    await page.getByLabel("Chat name", { exact: true }).fill("Renamed in Repositories");
    await page.getByRole("button", { name: "Back to Today", exact: true }).click();
    await expect(page.locator(".today-page")).toBeVisible();
    details = page.getByRole("region", { name: "Chat details", exact: true });
    await expect(details.getByLabel("Chat name", { exact: true })).toHaveValue("Renamed in Repositories");
    await expect(details.locator(".rendered-notes strong")).toHaveText("Saved");
    await expect(details.getByRole("button", { name: "Open Jira ticket DECK-42", exact: true })).toBeVisible();
    await app.resize(980, 650);
    await page.locator(".plan-details").evaluate((el) => { el.scrollTop = 0; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/today-chat-tools-minimum.png" });
    await app.resize(1320, 850);
    await page.screenshot({ path: "test-results/today-chat-tools-desktop.png" });
    await details.getByLabel("Chat name", { exact: true }).fill("Archived discussion");
    await details.getByRole("button", { name: "Archive chat", exact: true }).click();
    await expect(section.locator(".new-chats-count")).toHaveText("1");
    await section.getByRole("button", { name: "Select new chat Second chat to archive", exact: true }).click();
    await page.getByRole("button", { name: "Archive chat", exact: true }).click();
    await expect(section.locator(".new-chats-count")).toHaveText("0");
    await emit("UserPromptSubmit", { prompt: "Later provider activity" });
    const saved = await page.evaluate(() => window.deck.load());
    expect(saved.planning.items).toHaveLength(0);
    expect(saved.planning.entries).toHaveLength(0);
    expect(saved.chats.every((chat) => chat.archived)).toBe(true);
    const archived = saved.chats.find((chat) => chat.externalId === "taskless-chat")!;
    expect(archived.name).toBe("Archived discussion");
    expect(archived.notes).toContain("**Saved** without a task.");
    expect(archived.jiraKey).toBe("DECK-42");
    expect(saved.links.filter((link) => link.chatId === archived.id)).toHaveLength(1);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator(".new-chats-count")).toHaveText("0");
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    await page.getByRole("button", { name: "Archived chats 2", exact: true }).click();
    await page.getByRole("button", { name: "Select chat Archived discussion", exact: true }).click();
    await expect(page.getByRole("region", { name: "Chat links", exact: true })).toContainText("Discussion");
    await page.getByRole("button", { name: "Restore chat", exact: true }).click();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.locator(".today-page")).toBeVisible();
    await expect(page.locator(".new-chats-count")).toHaveText("1");
    await page.getByRole("button", { name: "Select new chat Archived discussion", exact: true }).click();
    await expect(page.getByLabel("Chat name", { exact: true })).toHaveValue("Archived discussion");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Today drains chat edits before navigation and task linking, and retains failed saves", async ({ launchRenderer }) => {
  const dir = mkdtempSync(join(tmpdir(), "acd-today-chat-save-"));
  const app = await launchRenderer({ dataDirectory: dir, commandReplyDelayMs: 100 });
  try {
    const page = await app.firstWindow();
    const state = await page.evaluate(async (day) => {
      await window.deck.command({ type: "createChat", name: "First chat", projectId: null });
      await window.deck.command({ type: "createChat", name: "Second chat", projectId: null });
      return window.deck.command({ type: "createPlanItem", name: "Destination", day, category: "Other" });
    }, localPlanDay());
    const first = state.chats.find((chat) => chat.name === "First chat")!;
    await page.getByRole("button", { name: "Select new chat First chat", exact: true }).click();
    await page.getByLabel("Chat name", { exact: true }).fill("First chat renamed");
    await page.getByRole("button", { name: "Edit notes", exact: true }).click();
    await page.getByLabel("Notes", { exact: true }).fill("Notes saved before switching chats");
    await page.getByRole("button", { name: "Select new chat Second chat", exact: true }).click();
    await expect(page.locator(".plan-details h2").first()).toHaveText("Second chat");
    let saved = await page.evaluate(() => window.deck.load());
    expect(saved.chats.find((chat) => chat.id === first.id)).toMatchObject({
      name: "First chat renamed", notes: "Notes saved before switching chats",
    });
    await page.getByRole("button", { name: "Select new chat First chat renamed", exact: true }).click();
    await page.getByRole("button", { name: "Add ticket", exact: true }).click();
    const ticket = page.getByLabel("Ticket number or full URL");
    await ticket.fill("javascript:unsafe()");
    await page.getByRole("button", { name: "Select new chat Second chat", exact: true }).click();
    await expect(ticket).toHaveValue("javascript:unsafe()");
    await page.getByRole("button", { name: "Archive chat", exact: true }).click();
    await page.getByRole("button", { name: "Link to existing task", exact: true }).click();
    const link = page.getByRole("form", { name: "Link new chat", exact: true });
    await link.getByLabel("Task", { exact: true }).selectOption(state.planning.items[0].id);
    await link.getByRole("button", { name: "Link chat", exact: true }).click();
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    await expect(ticket).toHaveValue("javascript:unsafe()");
    saved = await page.evaluate(() => window.deck.load());
    expect(saved.chats.find((chat) => chat.id === first.id)!.archived).toBe(false);
    expect(saved.planning.items[0].chatIds).toEqual([]);
    // A failed real save must keep both the draft and the current selection.
    await page.evaluate(() => {
      const command = window.deck.command;
      let fail = true;
      window.deck.command = (input) => {
        if (input.type === "updateChat" && fail) {
          fail = false;
          return Promise.reject(new Error("Temporary chat save failure"));
        }
        return command(input);
      };
    });
    await ticket.fill("DECK-13");
    await page.getByRole("button", { name: "Select new chat Second chat", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Temporary chat save failure" })).toBeVisible();
    await expect(ticket).toHaveValue("DECK-13");
    await expect(page.getByRole("button", { name: "Select new chat First chat renamed", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    await expect(page.locator(".save-row").getByRole("status")).toHaveText("Saved");
    await link.getByRole("button", { name: "Link chat", exact: true }).click();
    await expect(page.locator(".plan-details h2").first()).toHaveText("Destination");
    saved = await page.evaluate(() => window.deck.load());
    expect(saved.chats.find((chat) => chat.id === first.id)!.jiraKey).toBe("DECK-13");
    expect(saved.planning.items[0].chatIds).toEqual([first.id]);
    await expect(page.locator(".new-chats-count")).toHaveText("1");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
