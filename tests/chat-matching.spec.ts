import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localPlanDay } from "../src/shared/planning";
import { removeFixture } from "./fixture-cleanup";

test("Settings securely saves a write-only key, automatic links show a sparkle and X dismisses them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-matching-ui-")), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch({ executablePath: process.env.ACD_PACKAGED_EXECUTABLE,
    args: [...(process.env.ACD_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),...(process.env.ACD_PACKAGED_EXECUTABLE ? [] : [resolve(".")]), `--data-dir=${dir}`], env: { ...env, ACD_HTTP_PORT: "0" } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const initial = await page.evaluate(() => window.deck.load());
    test.skip(!initial.matching.secureStorageAvailable, "This OS has no protected credential backend");
    // Stub only the external model call, retaining the real IPC, crypto, storage and UI.
    const mock = async () => app.evaluate(() => {
      (globalThis as any).matchingRequestUrls = [];
      globalThis.fetch = async (_url, init) => {
        (globalThis as any).matchingRequestUrls.push(String(_url));
        const request = JSON.parse(String(init?.body));
        const input = JSON.parse(request.messages[1].content);
        return new Response(JSON.stringify({ model: request.model, provider: "Amazon Bedrock", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
          task_likelihoods: input.tasks.map((task: { id: string }) => ({ task_id: task.id, likelihood: 0.99 / input.tasks.length })),
          no_match_likelihood: 0.01, insufficient_context: false, reason: "Synthetic UI result",
        }) } }] }), { status: 200 });
      };
    });
    await mock();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("region", { name: "AI chat matching" });
    await expect(settings.getByLabel("OpenRouter API key", { exact: true })).toHaveAttribute("type", "password");
    await settings.getByLabel("OpenRouter API key", { exact: true }).fill("synthetic-ui-key-not-a-real-credential");
    await settings.getByRole("button", { name: "Save AI settings", exact: true }).click();
    await expect(settings.getByRole("status")).toHaveText("AI settings saved");
    await expect(settings.getByLabel("OpenRouter API key", { exact: true })).toHaveValue("");
    const saved = await page.evaluate(() => window.deck.load());
    expect(saved.matching.keyStored).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("synthetic-ui-key-not-a-real-credential");
    expect(readFileSync(join(dir, "workspace", "openrouter-key.enc")).includes(Buffer.from("synthetic-ui-key-not-a-real-credential"))).toBe(false);
    await settings.getByRole("button", { name: "Test connection", exact: true }).click();
    await expect(settings.getByRole("status")).toHaveText("Connection verified");
    const state = await page.evaluate(day => window.deck.command({ type: "importDailyPlan", card: `date: ${day}\ncoding:\n  - name: Payments\n    tickets: [PAY-142]\n`, sourceName: "fixture", itemIds: [null] }), localPlanDay());
    const item = state.planning.items[0];
    const sourceSnapshot = await page.evaluate(() => window.deck.command({ type: "createSource", name: "Claude", provider: "claude", environment: "native" }));
    const source = sourceSnapshot.sources[0], hookConfig = JSON.parse(sourceSnapshot.setups[source.id].config);
    const hook = hookConfig.hooks.UserPromptSubmit[0].hooks[0];
    const response = await fetch(hook.url, { method: "POST", headers: { ...hook.headers, "Content-Type": "application/json" }, body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "matching-ui", cwd: "/fixture/payments", prompt: "Investigate PAY-142 webhook retries" }) });
    expect(response.status).toBe(200);
    await app.evaluate(() => { globalThis.fetch = async () => new Response("", { status: 503 }); });
    await settings.getByLabel("Enable automatic chat links").check();
    await settings.getByRole("button", { name: "Save AI settings", exact: true }).click();
    await expect(settings.getByRole("alert")).toContainText("OpenRouter HTTP 503");
    await mock();
    // Saving unchanged settings must resume matching after a provider failure.
    await settings.getByRole("button", { name: "Save AI settings", exact: true }).click();
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(() => window.deck.load())).planning.items.find(task => task.id === item.id)?.automaticChatIds?.length, { timeout: 15_000 }).toBe(1);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Select task Payments", exact: true }).click();
    await expect(page.getByRole("img", { name: "Linked automatically by AI" })).toBeVisible();
    await page.locator(".task-linked-chat").hover();
    await page.getByRole("button", { name: "Remove linked chat Investigate PAY-142 webhook retries", exact: true }).click();
    await expect(page.getByRole("img", { name: "Linked automatically by AI" })).toHaveCount(0);
    await app.close(); app = await launch(); await mock(); page = await app.firstWindow();
    const restarted = await page.evaluate(() => window.deck.load());
    expect(restarted.matching.keyStored).toBe(true);
    expect(restarted.planning.items.find(task => task.id === item.id)?.chatIds).toEqual([]);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByLabel("OpenRouter API key", { exact: true })).toHaveValue("");
    await page.getByLabel("AI service", { exact: true }).selectOption("bedrock");
    await expect(page.getByLabel("Enable automatic chat links")).not.toBeChecked();
    const token = `synthetic-bedrock-${"x".repeat(2500)}`;
    await page.getByLabel("Bedrock API key", { exact: true }).fill(token);
    await page.getByRole("button", { name: "Save AI settings", exact: true }).click();
    await expect(page.getByLabel("Bedrock API key", { exact: true })).toHaveValue("");
    const bedrock = await page.evaluate(() => window.deck.load());
    expect(bedrock.matching.config.backend).toBe("bedrock");
    expect(bedrock.matching.config.bedrockModel).toBe("global.openai.gpt-6-luna");
    expect(JSON.stringify(bedrock)).not.toContain(token);
    expect(readFileSync(join(dir, "workspace", "bedrock-key.enc")).includes(Buffer.from(token))).toBe(false);
    await app.evaluate(() => {
      globalThis.fetch = async (_url, init) => new Response(JSON.stringify({ error: { code: "ValidationException",
        message: `Synthetic model access failure. ${new Headers(init?.headers).get("Authorization")}` } }), { status: 400, headers: { "x-amzn-requestid": "synthetic-request-123" } });
    });
    await page.getByRole("button", { name: "Test connection", exact: true }).click();
    const error = page.getByRole("region", { name: "AI chat matching" }).getByRole("alert");
    await expect(error).toContainText("Bedrock HTTP 400 (no retry): ValidationException — Synthetic model access failure.");
    await expect(error).toContainText("request synthetic-request-123");
    expect(await error.innerText()).not.toContain(token);
    await mock();
    await page.getByRole("button", { name: "Test connection", exact: true }).click();
    await expect(page.getByRole("region", { name: "AI chat matching" }).getByRole("status")).toHaveText("Connection verified");
    expect(await app.evaluate(() => (globalThis as any).matchingRequestUrls.at(-1))).toBe("https://bedrock-runtime.ap-southeast-2.amazonaws.com/openai/v1/chat/completions");
    await page.getByRole("button", { name: "Remove saved key", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Key removed; automatic linking is off" })).toBeVisible();
    expect((await page.evaluate(() => window.deck.load())).matching.keyStored).toBe(false);
    await page.getByLabel("AI service", { exact: true }).selectOption("openrouter");
    await page.getByRole("button", { name: "Save AI settings", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.deck.load())).matching.keyStored).toBe(true);
    await page.getByRole("button", { name: "Remove saved key", exact: true }).click();
  } finally { await app.close(); removeFixture(dir); }
});
