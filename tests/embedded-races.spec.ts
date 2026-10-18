import { test, expect } from "./renderer-fixture";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPlanDay } from "../src/shared/planning";

for (const switchTask of [false, true]) test(`delayed embedded send acknowledgement preserves ${switchTask ? "task" : "chat"} selection`, async ({ launchRenderer }) => {
  const dir = mkdtempSync(join(tmpdir(), "acd-embedded-race-"));
  const app = await launchRenderer({ dataDirectory: dir, embeddedFixture: true });
  try {
    const page = await app.firstWindow();
    const ids = await page.evaluate(async ({ dir, day, switchTask }) => {
      await window.deck.command({ type: "createPlanItem", day, category: "Other", name: "Synthetic race A" });
      await window.deck.command({ type: "createPlanItem", day, category: "Other", name: "Synthetic race B" });
      const tasks = (await window.deck.load()).planning.items;
      const aTask = tasks.find(t => t.name === "Synthetic race A")!.id;
      const bTask = tasks.find(t => t.name === "Synthetic race B")!.id;
      const a = (await window.deck.embedded({ type: "create", taskId: aTask, cwd: dir, name: "Synthetic chat A" })).chat!.chatId;
      const b = (await window.deck.embedded({ type: "create", taskId: switchTask ? bTask : aTask, cwd: dir, name: "Synthetic chat B" })).chat!.chatId;
      // Delay only delivery, after the real backend accepted the send. The
      // barrier is a renderer transport fault, not an SDK/provider event.
      const fault = window as unknown as { embeddedAckHeld: boolean; embeddedAckDelivered: boolean; releaseEmbeddedAck(): void };
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      fault.embeddedAckHeld = false; fault.embeddedAckDelivered = false; fault.releaseEmbeddedAck = release;
      const original = window.deck.embedded;
      window.deck.embedded = async input => {
        const reply = await original(input);
        if (input.type === "send" && input.chatId === a) { fault.embeddedAckHeld = true; await gate; fault.embeddedAckDelivered = true; }
        return reply;
      };
      return { a, b };
    }, { dir, day: localPlanDay(), switchTask });
    await page.getByRole("button", { name: "Select task Synthetic race A", exact: true }).click();
    const panel = page.getByRole("region", { name: "Embedded conversation" });
    await expect(panel.getByRole("combobox", { name: "Embedded chat", exact: true })).toHaveValue(ids.a);
    await panel.getByLabel("Message to Claude Agent").fill("Synthetic race prompt");
    await panel.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { embeddedAckHeld: boolean }).embeddedAckHeld)).toBe(true);
    if (switchTask) await page.getByRole("button", { name: "Select task Synthetic race B", exact: true }).click();
    else await panel.getByRole("combobox", { name: "Embedded chat", exact: true }).selectOption(ids.b);
    await expect(panel.getByRole("combobox", { name: "Embedded chat", exact: true })).toHaveValue(ids.b);
    await page.evaluate(() => (window as unknown as { releaseEmbeddedAck(): void }).releaseEmbeddedAck());
    await expect.poll(() => page.evaluate(() => (window as unknown as { embeddedAckDelivered: boolean }).embeddedAckDelivered)).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    // call().finally must have rendered before the final selection assertion.
    await expect(panel.getByRole("button", { name: "New embedded chat", exact: true })).toBeEnabled();
    await expect(panel.getByRole("combobox", { name: "Embedded chat", exact: true })).toHaveValue(ids.b);
    if (switchTask) await expect(panel.getByRole("log")).not.toContainText("Synthetic race prompt");
    const original = (await page.evaluate(chatId => window.deck.embedded({ type: "read", chatId }), ids.a)).chat!;
    expect(original.events.filter(e => e.kind === "user")).toHaveLength(1);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
