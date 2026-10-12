import { test, expect } from "./renderer-fixture";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPlanDay, nextPlanDay } from "../src/shared/planning";

test("Today discovers unlinked chats and supports linking, creation, undo, and persistent collapse", async ({ launchRenderer }) => {
  const dir = mkdtempSync(join(tmpdir(), "acd-new-chats-"));
  let app = await launchRenderer({ dataDirectory: dir, commandReplyDelayMs: 50 });
  try {
    let page = await app.firstWindow();
    const today = localPlanDay();
    const initial = await page.evaluate(async ({ today, previous }) => {
      for (let i = 1; i <= 6; i++) await window.deck.command({ type: "createChat", name: `Fresh chat ${i}`, projectId: null });
      let state = await window.deck.load();
      const first = state.chats.find((c) => c.name === "Fresh chat 1")!;
      const second = state.chats.find((c) => c.name === "Fresh chat 2")!;
      await window.deck.command({ type: "createPlanItem", day: previous, category: "Coding", name: "Earlier card", chatIds: [first.id] });
      await window.deck.command({ type: "updateChat", id: second.id, patch: { archived: true } });
      await window.deck.command({ type: "createPlanItem", day: today, category: "Coding", name: "Earlier card" });
      return window.deck.load();
    }, { today, previous: nextPlanDay(today, -1) });
    const section = page.getByRole("region", { name: "New chats", exact: true });
    await expect(section.locator(".new-chats-count")).toHaveText("4");
    await expect(section.locator(".new-chat-row")).toHaveCount(3);
    await expect(section).not.toContainText("Fresh chat 1");
    await expect(section).not.toContainText("Fresh chat 2");
    const filters = await page.locator(".planning-filter-bar").boundingBox();
    const newBox = await section.boundingBox();
    const search = await page.getByRole("searchbox", { name: "Search tasks", exact: true }).boundingBox();
    expect(filters!.y + filters!.height).toBeLessThanOrEqual(newBox!.y);
    expect(newBox!.y + newBox!.height).toBeLessThanOrEqual(search!.y);
    await expect(page.locator(".planning-filter-bar").getByRole("button", { name: "Import card", exact: true })).toBeVisible();
    await section.getByRole("button", { name: "Show 1 more", exact: true }).click();
    await expect(section.locator(".new-chat-row")).toHaveCount(4);
    await section.getByRole("button", { name: "Select new chat Fresh chat 6", exact: true }).click();
    await expect(page.locator(".plan-row.selected")).toHaveCount(0);
    await page.getByRole("button", { name: "Link to existing task", exact: true }).click();
    const earlier = initial.planning.items.find((i) => i.name === "Earlier card")!;
    const picker = page.getByRole("form", { name: "Link new chat", exact: true }).getByLabel("Task", { exact: true });
    await expect(picker.getByRole("option", { name: `Earlier card · ${nextPlanDay(today, -1)} · Coding`, exact: true })).toHaveAttribute("value", earlier.id);
    await expect(picker.getByRole("option", { name: `Earlier card · ${today} · Coding`, exact: true })).toHaveCount(1);
    await page.getByRole("form", { name: "Link new chat", exact: true }).getByLabel("Task", { exact: true }).selectOption(earlier.id);
    await page.getByRole("form", { name: "Link new chat", exact: true }).getByRole("button", { name: "Link chat", exact: true }).click();
    await expect(section.locator(".new-chats-count")).toHaveText("3");
    await expect(page.locator(".plan-details h2").first()).toHaveText("Earlier card");
    const linked = await page.evaluate(() => window.deck.load());
    expect(linked.planning.items.find((i) => i.id === earlier.id)!.chatIds).toHaveLength(2);
    expect(linked.planning.entries.filter((e) => e.itemId === earlier.id)).toHaveLength(1);
    await page.evaluate(() => window.deck.command({ type: "savePlanDraft", key: "task-create", value: '{"name":"Unfinished task"}' }));
    await section.getByRole("button", { name: "Select new chat Fresh chat 5", exact: true }).click();
    await page.getByRole("button", { name: "Create task from chat", exact: true }).click();
    const form = page.getByRole("form", { name: "Create task from chat", exact: true });
    await form.getByLabel("Task name", { exact: true }).fill("Review fresh work");
    await form.getByLabel("Category", { exact: true }).selectOption("Other");
    await form.getByRole("button", { name: "Create task", exact: true }).click();
    await expect(section.locator(".new-chats-count")).toHaveText("2");
    await expect(page.locator(".plan-details h2").first()).toHaveText("Review fresh work");
    const created = await page.evaluate(() => window.deck.load());
    const task = created.planning.items.find((i) => i.name === "Review fresh work")!;
    expect(task.chatIds).toEqual([initial.chats.find((c) => c.name === "Fresh chat 5")!.id]);
    expect(created.planning.entries.find((e) => e.itemId === task.id)).toMatchObject({ day: today, category: "Other", workedOn: false });
    expect(created.planning.drafts["task-create"]).toBe('{"name":"Unfinished task"}');
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(section.locator(".new-chats-count")).toHaveText("3");
    const toggle = section.locator(".new-chats-heading");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(page.locator(".new-chats-heading")).toHaveAttribute("aria-expanded", "false");
    await page.locator(".new-chats-heading").click();
    await page.getByRole("button", { name: "Select new chat Fresh chat 5", exact: true }).click();
    await app.resize(980, 650);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/today-new-chats-minimum.png" });
    await app.resize(1320, 850);
    await page.screenshot({ path: "test-results/today-new-chats-desktop.png" });
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const change of ["linked elsewhere", "next day"] as const) {
  test(`New chat detail expires when the chat is ${change}`, async ({ launchRenderer }) => {
    const dir = mkdtempSync(join(tmpdir(), "acd-new-chat-expiry-"));
    const app = await launchRenderer({ dataDirectory: dir });
    try {
      const page = await app.firstWindow();
      const state = await page.evaluate(async (day) => {
        await window.deck.command({ type: "createChat", name: "Selected fresh chat", projectId: null });
        return window.deck.command({ type: "createPlanItem", day, category: "Other", name: "Destination" });
      }, localPlanDay());
      const section = page.getByRole("region", { name: "New chats", exact: true });
      await section.getByRole("button", { name: "Select new chat Selected fresh chat", exact: true }).click();
      await expect(page.locator(".new-chat-context-label")).toHaveText("New · created today");
      if (change === "linked elsewhere") {
        await page.evaluate(({ itemId, chatId }) => window.deck.command({ type: "setPlanChats", id: itemId, chatIds: [chatId] }), {
          itemId: state.planning.items[0].id,
          chatId: state.chats[0].id,
        });
      } else {
        await page.clock.setFixedTime(new Date(`${nextPlanDay(localPlanDay())}T12:00:00`));
        // A snapshot notification rerenders the same way as the observation-age timer.
        await page.evaluate(() => window.dispatchEvent(new Event("deck-test-changed")));
      }
      await expect(section.locator(".new-chats-count")).toHaveText("0");
      await expect(page.getByRole("heading", { name: "Chat no longer available", exact: true })).toBeVisible();
      await expect(page.locator(".new-chat-context-label")).toHaveCount(0);
      await expect(section.locator(".new-chat-row.selected")).toHaveCount(0);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("opening a New chat clears the Needs attention selection", async ({ launchRenderer }) => {
  const dir = mkdtempSync(join(tmpdir(), "acd-new-chat-attention-"));
  const app = await launchRenderer({ dataDirectory: dir });
  try {
    const page = await app.firstWindow();
    const state = await page.evaluate(async () => {
      await window.deck.command({ type: "createChat", name: "Other fresh chat", projectId: null });
      return window.deck.command({ type: "createSource", name: "Local Claude", provider: "claude", environment: "native" });
    });
    const hooks = JSON.parse(state.setups[state.sources[0].id].config).hooks;
    for (const [event, extra] of [
      ["UserPromptSubmit", { prompt: "Review attention selection" }],
      ["Notification", { notification_type: "permission_prompt", message: "Allow reading the report?" }],
    ] as const) {
      const hook = hooks[event][0].hooks[0];
      const reply = await fetch(hook.url, {
        method: "POST",
        headers: { ...hook.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ hook_event_name: event, session_id: "new-chat-attention", cwd: "/work/deck", ...extra }),
      });
      expect(reply.status).toBe(200);
    }
    await page.getByRole("button", { name: "Needs attention 1", exact: true }).click();
    await page.locator(".plan-row").click();
    await expect(page.locator(".plan-row.selected")).toHaveCount(1);
    await page.getByRole("button", { name: "Select new chat Other fresh chat", exact: true }).click();
    await expect(page.locator(".new-chat-row.selected")).toHaveCount(1);
    await expect(page.locator(".plan-row.selected")).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
