import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Claude monitoring uses existing HTTP hooks, stays visible between turns and clears explicitly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-monitoring-ui-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
    ),
  ) as Record<string, string>;
  const app = await electron.launch({
    executablePath: process.env.ACD_PACKAGED_EXECUTABLE,
    args: [
      ...(process.env.ACD_PACKAGED_EXECUTABLE ? [] : [resolve(".")]),
      `--data-dir=${dir}`,
    ],
    env: { ...env, ACD_HTTP_PORT: "0" },
  });
  try {
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const initial = await page.evaluate(() =>
      window.deck.command({
        type: "createSource",
        name: "Local Claude",
        provider: "claude",
        environment: "native",
      }),
    );
    const source = initial.sources[0];
    const config = JSON.parse(initial.setups[source.id].config);
    const emit = async (event: string, extra: Record<string, unknown> = {}) => {
      const hook = config.hooks[event][0].hooks[0];
      const response = await fetch(hook.url, {
        method: "POST",
        headers: { ...hook.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          hook_event_name: event,
          session_id: "monitoring",
          cwd: "/work/watch-ci",
          ...extra,
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
    };
    await emit("UserPromptSubmit", { prompt: "Watch the build" });
    const row = page.getByRole("button", {
      name: "Select chat Watch the build",
      exact: true,
    });
    await row.click();
    const details = page.getByLabel("Chat details");
    await page
      .getByRole("button", {
        name: "Priority repository watch-ci",
        exact: true,
      })
      .click();
    const session_crons = [
      {
        id: "poll",
        schedule: "*/10 * * * *",
        recurring: true,
        prompt: "Check CI <script>alert(1)</script>",
      },
    ];
    await emit("Stop", { background_tasks: [], session_crons });
    await expect(row.locator(".status")).toHaveText(
      "Monitoring · waiting for next check",
    );
    await expect(details.locator(".activity-heading .status")).toHaveText(
      "Monitoring · waiting for next check",
    );
    await expect(row).not.toHaveClass(/priority-attention/);
    const filters = page.getByRole("navigation", {
      name: "Quick status filters",
    });
    await filters.getByRole("button", { name: /^Monitoring / }).click();
    await expect(row).toBeVisible();
    await filters.getByRole("button", { name: /^Running / }).click();
    await expect(row).toHaveCount(0);
    await filters.getByRole("button", { name: /^Finished turns / }).click();
    await expect(row).toHaveCount(0);
    await page.getByLabel("State filter").selectOption("monitoring");
    await expect(row).toBeVisible();
    await details
      .getByText("Background work and scheduled checks", { exact: true })
      .click();
    const observations = page.getByLabel("Background observations");
    await expect(observations).toContainText("Recurring · */10 * * * *");
    await expect(observations).toContainText("Last observation");
    await expect(observations.locator("script, img, a")).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(980, 650),
    );
    await page.screenshot({
      path: "test-results/monitoring-minimum.png",
      fullPage: true,
    });
    await filters.getByRole("button", { name: /^All / }).click();
    await emit("UserPromptSubmit", { prompt: "Check again" });
    await expect(row.locator(".status")).toHaveText(
      "Running · 1 scheduled check",
    );
    await emit("Stop", {
      background_tasks: [
        {
          id: "monitor",
          type: "monitor",
          status: "running",
          description: "Watch CI",
        },
      ],
      session_crons: [],
    });
    await expect(row.locator(".status")).toHaveText(
      "Monitoring · 1 monitor observed",
    );
    await emit("Notification", {
      notification_type: "permission_prompt",
      message: "Needs permission",
    });
    await expect(row.locator(".status")).toHaveText(
      "Needs input · 1 monitor observed",
    );
    await expect(row).toHaveClass(/priority-attention/);
    await emit("Stop", { background_tasks: [], session_crons: [] });
    await expect(row.locator(".status")).toHaveText("Turn finished");
    await expect(row).toHaveClass(/priority-attention/);
    await expect(observations).toHaveCount(0);
    await filters.getByRole("button", { name: /^Finished turns / }).click();
    await expect(row).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
