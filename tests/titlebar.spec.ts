import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("title bar navigation stays clear of native controls at minimum size and fullscreen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-titlebar-"));
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
      "--demo",
    ],
    env: { ...env, ACD_HTTP_PORT: "0" },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "Leave demo", exact: true })).toBeVisible();
    if (process.platform !== "darwin") {
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible())).toBe(false);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 650));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(980);

    const assertSafeHeader = async () => {
      // Read Electron's live Window Controls Overlay geometry rather than
      // assuming caption button sizes or which side of the window they occupy.
      await expect.poll(() => page.evaluate(() => {
        const overlay = (navigator as Navigator & {
          windowControlsOverlay: { visible: boolean; getTitlebarAreaRect(): DOMRect };
        }).windowControlsOverlay;
        const safe = overlay.getTitlebarAreaRect();
        const header = document.querySelector(".titlebar")!;
        const heading = header.querySelector("h1")!;
        const buttons = Array.from(header.querySelectorAll("button"));
        const bounds = [heading, ...buttons].map((element) => element.getBoundingClientRect());
        const left = overlay.visible ? safe.x : 0;
        const right = overlay.visible ? safe.right : innerWidth;
        return {
          draggable: getComputedStyle(header).getPropertyValue("-webkit-app-region"),
          buttonsClickable: buttons.every((button) => getComputedStyle(button).getPropertyValue("-webkit-app-region") === "no-drag"),
          inSafeArea: bounds.every((b) => b.left >= left && b.right <= right && b.top >= 0 && b.bottom <= 64),
          noOverlap: heading.getBoundingClientRect().right <= buttons[0].getBoundingClientRect().left,
          noHorizontalScroll: document.documentElement.scrollWidth === innerWidth,
        };
      })).toEqual({
        draggable: "drag",
        buttonsClickable: true,
        inSafeArea: true,
        noOverlap: true,
        noHorizontalScroll: true,
      });
    };
    await assertSafeHeader();
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add source", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/titlebar-minimum.png" });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
    await assertSafeHeader();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
    await assertSafeHeader();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
    await assertSafeHeader();
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
