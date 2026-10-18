import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  Notification,
  shell,
  safeStorage,
} from "electron";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { resolveTicketUrl } from "../shared/tickets";
import { idSchema, ticketUrl } from "../shared/validation";
import { WorkspaceRuntime } from "./workspace-runtime";
import { InputIndicator } from "./attention";
import { dockIconWithLamp, inputLamp } from "./attention-image";

const encryption = {
  available: () => safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" || !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())),
  encrypt: async (key: string) => {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("Encryption unavailable");
    return safeStorage.encryptStringAsync(key);
  },
  decrypt: async (encrypted: Buffer) => {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("Encryption unavailable");
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    return decrypted.shouldReEncrypt ? (await safeStorage.decryptStringAsync(encrypted)).result : decrypted.result;
  },
};

app.setName("Agent Control Deck");
const argument = process.argv.find((a) => a.startsWith("--data-dir="));
if (argument) {
  const path = resolve(argument.slice("--data-dir=".length));
  mkdirSync(path, { recursive: true });
  app.setPath("userData", path);
}
let window: BrowserWindow | null = null;
let inputIndicator: InputIndicator | undefined;
let notifiedRequests = new Set<string>();
const workspace = new WorkspaceRuntime(
  app.getPath("userData"),
  () => {
    updateInputIndicator();
    window?.webContents.send("deck:changed");
    try { notifyRequests(); } catch (error) { console.warn("Could not display the request notification",error); }
  },
  process.argv.includes("--demo"),
  encryption,
);
function notifyRequests(): void {
  const requests = workspace.interactions.snapshot();
  for (const request of requests) {
    if (notifiedRequests.has(request.id)) continue;
    if (window && !window.isFocused() && Notification.isSupported()) {
      const notification = new Notification({ title: `${request.provider === "codex" ? "Codex" : "Claude Code"} needs ${request.kind === "permission" ? "permission" : "your answer"}`,
        body: `${request.sourceName} · ${request.description || request.toolName}`.slice(0,200), silent: true });
      notification.on("click", () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
      notification.show();
    }
  }
  notifiedRequests = new Set(requests.map(r => r.id));
}
function updateInputIndicator(force = false): void {
  try {
    const chats = workspace.store.chats();
    // Include unanswered requests even before the first observed user prompt.
    for (const request of workspace.interactions.snapshot()) {
      const chat = chats.find(c => c.sourceId === request.sourceId && c.externalId === request.sessionId);
      if (chat) { chat.state = "waiting"; chat.archived = false; chat.lifecycle = "open"; }
      else chats.push({ id: request.id, archived: false, lifecycle: "open", state: "waiting" } as typeof chats[number]);
    }
    inputIndicator?.update(chats, force);
  } catch (error) {
    // OS decoration failures must not interrupt ingestion or user edits.
    console.warn("Could not update the input indicator", error);
  }
}
function initializeInputIndicator(): void {
  if (process.platform === "win32") {
    const lamp = inputLamp();
    inputIndicator = new InputIndicator((count) => {
      window?.setOverlayIcon(
        count ? lamp : null,
        count
          ? `${count} ${count === 1 ? "chat needs" : "chats need"} input`
          : "",
      );
    });
  } else if (process.platform === "darwin") {
    // AppKit supplies the actual application icon at its native resolution.
    const original = nativeImage.createFromNamedImage("NSApplicationIcon");
    if (original.isEmpty())
      throw new Error("The application's Dock icon is unavailable");
    const lit = dockIconWithLamp(original);
    inputIndicator = new InputIndicator((count) =>
      app.dock?.setIcon(count ? lit : original),
    );
  }
}
const renderer = join(__dirname, "../renderer/index.html");
const devUrl = process.env.ELECTRON_RENDERER_URL;
function trusted(event: Electron.IpcMainInvokeEvent): boolean {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return false;
  try {
    const actual = new URL(event.senderFrame.url);
    return devUrl
      ? actual.origin === new URL(devUrl).origin
      : actual.href === pathToFileURL(renderer).href;
  } catch {
    return false;
  }
}
function handle(
  channel: string,
  fn: (input: unknown) => unknown | Promise<unknown>,
): void {
  ipcMain.handle(channel, async (event, input) => {
    if (!trusted(event))
      return { ok: false, error: "Untrusted application frame" };
    try {
      return { ok: true, value: await fn(input) };
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? error.issues.map((i) => i.message).join("; ")
          : error instanceof Error
            ? error.message
            : "Operation failed";
      return { ok: false, error: message };
    }
  });
}
function registerIpc(): void {
  handle("deck:embedded", input => workspace.embedded.command(input));
  handle("deck:save-matching", input => workspace.saveMatching(input));
  handle("deck:remove-matching-key", input => workspace.removeMatchingKey(input));
  handle("deck:test-matching-connection", input => workspace.testMatchingConnection(input));
  handle("deck:install-local-matching", input => workspace.installLocalMatching(input));
  handle("deck:matching-analytics", input => workspace.matchingAnalytics(input));
  handle("deck:export-matching-analytics", input => workspace.exportMatchingAnalytics(input));
  handle("deck:clear-matching-analytics", input => workspace.clearMatchingAnalytics(input));
  handle("deck:suggest-continuation", input => workspace.suggestContinuation(input));
  handle("deck:load", () => workspace.snapshot());
  handle("deck:activity", (input) =>
    workspace.store.activity(idSchema.parse(input)),
  );
  handle("deck:copy", (input) =>
    clipboard.writeText(z.string().max(100000).parse(input)),
  );
  handle("deck:open-ticket", async (input) => {
    const url = resolveTicketUrl(
      workspace.store.chat(idSchema.parse(input)),
      workspace.store.settings(),
    );
    if (url) await shell.openExternal(url);
  });
  handle("deck:open-link", async (input) => {
    await shell.openExternal(
      ticketUrl.parse(workspace.store.link(idSchema.parse(input)).url),
    );
  });
  handle("deck:open-plan-link", async (input) => {
    await shell.openExternal(workspace.planLinkUrl(input));
  });
  handle("deck:open-plan-ticket", async (input) => {
    const url = workspace.planTicketUrl(input);
    if (url) await shell.openExternal(url);
  });
  handle("deck:command", (input) => workspace.command(input));
  handle("deck:respond", (input) => workspace.respond(input));
}
function createWindow(): void {
  window = new BrowserWindow({
    width: 1320,
    height: 850,
    minWidth: 980,
    minHeight: 650,
    title: "Agent Control Deck",
    backgroundColor: "#f5f6f8",
    titleBarStyle: "hidden",
    // Keep OS window controls (including Windows snap layouts) over our header.
    titleBarOverlay: {
      color: "#ffffff",
      symbolColor: "#253044",
      height: 64,
    },
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 16, y: 24 } }
      : {}),
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // macOS retains its system menu; Windows/Linux have no in-window menu bar.
  if (process.platform !== "darwin") window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on("will-prevent-unload", (event) => {
    const discard = dialog.showMessageBoxSync(window!, {
      type: "warning",
      buttons: ["Keep editing", "Discard unsaved edits"],
      defaultId: 0,
      cancelId: 0,
      message: "Some edits have not been saved.",
      detail:
        "Keep the window open to retry saving, or discard only the unsaved edits.",
    });
    if (discard === 1) event.preventDefault();
  });
  window.on("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = null;
  });
  updateInputIndicator(true);
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(renderer);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  void app
    .whenReady()
    .then(async () => {
      await workspace.start();
      try {
        initializeInputIndicator();
      } catch (error) {
        console.warn("Could not initialize the input indicator", error);
      }
      registerIpc();
      createWindow();
      app.on("activate", () => {
        if (!window) createWindow();
      });
    })
    .catch((error) => {
      dialog.showErrorBox("Could not open Agent Control Deck", String(error));
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    workspace.close();
  });
}
