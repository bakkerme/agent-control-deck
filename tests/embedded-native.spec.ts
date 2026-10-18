// Synthetic SDK fixture suite is separate from packaged production smoke tests.
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localPlanDay } from "../src/shared/planning";

test.skip(!!process.env.ACD_PACKAGED_EXECUTABLE, "Synthetic SDK build is tested separately from packaged production smoke");

test("native embedded IPC isolates questions and stale decisions across same-folder tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-native-embedded-"));
  const app = await electron.launch({ args: [...(process.env.ACD_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), resolve("out-tests/native-app"), `--data-dir=${dir}`],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>, ACD_EMBEDDED_PROVIDER: "anthropic", ACD_HTTP_PORT: "0", ACD_EMBEDDED_CHAT: "1", ACD_EMBEDDED_AUTH: "api-key", ANTHROPIC_API_KEY: "synthetic-native-key" } });
  try {
    const page = await app.firstWindow();
    const ids = await page.evaluate(async ({ dir, day }) => {
      for (const name of ["Synthetic native A", "Synthetic native B"]) await window.deck.command({ type: "createPlanItem", day, category: "Other", name });
      const tasks = (await window.deck.load()).planning.items;
      const chats = [];
      for (const task of tasks) chats.push((await window.deck.embedded({ type: "create", taskId: task.id, name: task.name, cwd: dir })).chat!);
      return chats;
    }, { dir, day: localPlanDay() });
    for (const chat of ids) await page.evaluate(chatId => window.deck.embedded({ type: "send", chatId, sendId: crypto.randomUUID(), text: "Synthetic native question" }), chat.chatId);
    const pending = await page.evaluate(async chats => Promise.all(chats.map(async chat => (await window.deck.embedded({ type: "read", chatId: chat.chatId })).chat!)), ids);
    expect(pending.every(c => c.requests.length === 1)).toBe(true);
    expect(pending[0].sessionId).not.toBe(pending[1].sessionId);
    await expect(page.evaluate(({ chatId, requestId }) => window.deck.embedded({ type: "decide", chatId, requestId, allow: true, answers: { "Which synthetic option?": "A" } }), { chatId: ids[1].chatId, requestId: pending[0].requests[0].id })).rejects.toThrow(/expired/);
    await page.getByRole("button", { name: "Select task Synthetic native B", exact: true }).click();
    const panel = page.getByRole("region", { name: "Embedded conversation" });
    await panel.getByLabel("Which synthetic option?", { exact: true }).fill("B");
    await panel.getByRole("button", { name: "Send answers", exact: true }).click();
    await expect(panel.getByRole("log")).toContainText("Turn complete");
    await page.reload();
    await page.getByRole("button", { name: "Select task Synthetic native A", exact: true }).click();
    await expect(panel.getByRole("region", { name: "Request AskUserQuestion", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Cancel turn", exact: true }).click();
    await expect(panel.getByRole("log")).toContainText("Turn cancelled");
    await expect(page.evaluate(({ chatId, requestId }) => window.deck.embedded({ type: "decide", chatId, requestId, allow: true, answers: { "Which synthetic option?": "A" } }), { chatId: ids[0].chatId, requestId: pending[0].requests[0].id })).rejects.toThrow(/expired/);
    expect(existsSync(join(dir, "effects.txt"))).toBe(false);
    expect(await page.evaluate(() => ({ require: typeof (window as any).require, process: typeof (window as any).process }))).toEqual({ require: "undefined", process: "undefined" });
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("native committed effect survives cancel and app restart without replaying the accepted send", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-native-effect-"));
  const launch = () => electron.launch({ args: [...(process.env.ACD_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), resolve("out-tests/native-app"), `--data-dir=${dir}`],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>, ACD_EMBEDDED_PROVIDER: "anthropic", ACD_HTTP_PORT: "0", ACD_EMBEDDED_CHAT: "1", ACD_EMBEDDED_AUTH: "api-key", ANTHROPIC_API_KEY: "synthetic-native-key" } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const chatId = await page.evaluate(async ({ dir, day }) => {
      await window.deck.command({ type: "createPlanItem", day, category: "Other", name: "Synthetic native effect task" });
      const task = (await window.deck.load()).planning.items[0];
      return (await window.deck.embedded({ type: "create", taskId: task.id, cwd: dir, name: "Synthetic effect chat" })).chat!.chatId;
    }, { dir, day: localPlanDay() });
    await page.getByRole("button", { name: "Select task Synthetic native effect task", exact: true }).click();
    let panel = page.getByRole("region", { name: "Embedded conversation" });
    const send = async () => { await panel.getByLabel("Message to Claude Agent").fill("Synthetic native effect"); await panel.getByRole("button", { name: "Send message", exact: true }).click(); };
    await send(); await panel.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(panel.getByRole("log")).toContainText("Turn complete");
    expect(existsSync(join(dir, "effects.txt"))).toBe(false);
    await send(); await panel.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect.poll(() => existsSync(join(dir, "effects.txt"))).toBe(true);
    expect(readFileSync(join(dir, "effects.txt"), "utf8")).toBe("committed\n");
    const accepted = (await page.evaluate(chatId => window.deck.embedded({ type: "read", chatId }), chatId)).chat!;
    const sendId = accepted.events.filter(e => e.kind === "user").at(-1)!.id.slice(5);
    await panel.getByRole("button", { name: "Cancel turn", exact: true }).click();
    await expect(panel.getByRole("log")).toContainText("Turn cancelled");
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.getByRole("button", { name: "Select task Synthetic native effect task", exact: true }).click();
    panel = page.getByRole("region", { name: "Embedded conversation" });
    await page.evaluate(({ chatId, sendId }) => window.deck.embedded({ type: "send", chatId, sendId, text: "Synthetic native effect" }), { chatId, sendId });
    expect(await app.evaluate(() => (globalThis as any).acdAcceptance.calls)).toBe(0);
    expect(readFileSync(join(dir, "effects.txt"), "utf8")).toBe("committed\n");
    expect((await page.evaluate(chatId => window.deck.embedded({ type: "read", chatId }), chatId)).chat!.sessionId).toBe(accepted.sessionId);
    await expect(panel.getByRole("log")).not.toContainText("synthetic acknowledgement");
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
