import { notesField, organizationField } from "./ui-helpers";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

test("Codex source setup, HTTP events, filtering and automatic chat fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-codex-ui-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  const app = await electron.launch({
    executablePath: process.env.ACD_PACKAGED_EXECUTABLE,
    args: [...(process.env.ACD_PACKAGED_EXECUTABLE ? [] : [resolve(".")]), `--data-dir=${dir}`], env: { ...env, ACD_HTTP_PORT: "0" },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    await page.getByLabel("Source name").fill("Local Codex");
    await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("codex");
    await page.getByRole("button", { name: "Create source", exact: true }).click();
    await expect(page.getByLabel("Hook configuration")).toContainText("Interrupt");
    await expect(page.getByText(/review and trust these hooks/)).toBeVisible();
    const snapshot = await page.evaluate(() => window.deck.load());
    const config = JSON.parse(snapshot.setups[snapshot.sources[0].id].config);
    const emit = async (event: string, extra: Record<string, unknown>) => {
      const command = config.hooks[event][0].hooks[0].command;
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
        const child = spawn(process.platform === "win32" ? "cmd.exe" : "sh", process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command]);
        let stdout = "", stderr = "";
        child.stdout.on("data", (data) => stdout += data);
        child.stderr.on("data", (data) => stderr += data);
        child.on("error", reject);
        child.on("close", (status) => resolveResult({ status, stdout, stderr }));
        child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: "ui-codex", cwd: "/work/codex-project", ...extra }));
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(event === "Stop" ? "{}" : "");
    };
    await emit("UserPromptSubmit", { turn_id: "t1", prompt: "Watch my Codex chat" });
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByLabel("Provider filter").selectOption("codex");
    await page.getByRole("button", { name: "Select chat Watch my Codex chat" }).click();
    const details = page.getByLabel("Chat details");
    await expect(details.getByText("Running", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Manual state")).toHaveCount(0);
    await expect(details.getByRole("combobox", { name: "Session", exact: true })).toHaveCount(0);
    await (await notesField(page)).fill("My notes stay mine");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await emit("Stop", { turn_id: "t1", stop_hook_active: false, last_assistant_message: "Codex integration complete" });
    await expect(details.getByText("Turn finished", { exact: true })).toBeVisible();
    await expect(details.getByText("Codex integration complete", { exact: true })).toBeVisible();
    await expect((await notesField(page))).toHaveValue("My notes stay mine");
    // File context must not become the title, and preview formatting must survive
    // HTTP, database, preload, and Electron renderer.
    await emit("UserPromptSubmit", { session_id: "ui-codex-files", prompt: "# Files mentioned by the user:\n\n## memcard-viewer: /Users/brandon/Library/Mobile Documents/com~apple~CloudDocs/memcard-viewer\n\n<user_query>Fix the card viewer</user_query>" });
    await page.getByRole("button", { name: "Select chat Fix the card viewer", exact: true }).click();
    await (await organizationField(page, "Chat name")).fill("My card viewer");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await emit("Stop", { session_id: "ui-codex-files", last_assistant_message: "## Ready for review\n\n**Cards** now render.\n\n- Keep `paths`\n- Preserve notes\n\n```ts\nconst ready = true;\n```\n\n<script>alert(1)</script>\n\n![Remote](https://example.com/image.png)\n\n[Bad](javascript:alert%281%29)" });
    const preview = details.locator(".preview .markdown");
    await expect(preview.getByRole("heading", { name: "Ready for review" })).toBeVisible();
    await expect(preview.locator("strong")).toHaveText("Cards");
    await expect(preview.locator("li")).toHaveCount(2);
    await expect(preview.locator("pre code")).toContainText("const ready = true;");
    await expect(preview.locator("script, img, a")).toHaveCount(0);
    await expect(details.getByRole("heading", { name: "My card viewer", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select chat My card viewer", exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/codex-chat.png", fullPage: true });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
