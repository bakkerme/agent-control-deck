import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Electron startup, preload isolation, trusted IPC and restart persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-electron-smoke-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
    ),
  ) as Record<string, string>;
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
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "New chat", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => ({
        require: typeof (window as any).require,
        process: typeof (window as any).process,
      })),
    ).toEqual({ require: "undefined", process: "undefined" });
    await expect(
      page.evaluate(() =>
        window.deck.command({ type: "createProject", name: "" }),
      ),
    ).rejects.toThrow();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .fill("Electron persistence");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create chat", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Select chat Electron persistence" }),
    ).toBeVisible();
    // An unrelated renderer cannot invoke the main window IPC handlers.
    expect(
      await app.evaluate(async ({ BrowserWindow }) => {
        const window = new BrowserWindow({
          show: false,
          webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
          },
        });
        try {
          await window.loadURL("about:blank");
          return await window.webContents.executeJavaScript(
            'require("electron").ipcRenderer.invoke("deck:load")',
          );
        } finally {
          window.destroy();
        }
      }),
    ).toEqual({ ok: false, error: "Untrusted application frame" });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Select chat Electron persistence" }),
    ).toBeVisible();
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
