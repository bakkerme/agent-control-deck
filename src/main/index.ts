import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
} from "electron";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { resolveTicketUrl } from "../shared/tickets";
import type { Snapshot } from "../shared/types";
import { commandSchema, idSchema } from "../shared/validation";
import { Store } from "./store";
import { Inbox } from "./inbox";
import { sourceSetup, writeHookSetup, type HookConnection } from "./setup";
import { HookReceiver } from "./http";
import { advanceDemo, seedDemo } from "./demo";

app.setName("Agent Control Deck");
const argument = process.argv.find((a) => a.startsWith("--data-dir="));
if (argument) {
  const path = resolve(argument.slice("--data-dir=".length));
  mkdirSync(path, { recursive: true });
  app.setPath("userData", path);
}
let demo = process.argv.includes("--demo");
let store: Store;
let inbox: Inbox;
let window: BrowserWindow | null = null;
let timer: NodeJS.Timeout | undefined;
let ingestionError: string | null = null;
let connection: HookConnection;
let receiver: HookReceiver | undefined;
const base = app.getPath("userData");
const dataRoot = () => (demo ? join(base, "demo") : join(base, "workspace"));
const changed = () => window?.webContents.send("deck:changed");
function openStore(): void {
  store = new Store(join(dataRoot(), "workspace.sqlite"));
  if (demo) seedDemo(store);
  for (const source of store.sources()) {
    try {
      writeHookSetup(dataRoot(), source, connection);
    } catch {
      store.sourceError(
        source.id,
        "Could not create HTTP hook configuration. Check directory permissions.",
      );
    }
  }
  inbox = new Inbox(store, dataRoot(), changed);
}
function pollInbox(): void {
  const before = ingestionError;
  try {
    inbox.poll();
    ingestionError = null;
  } catch {
    ingestionError = "Event ingestion is paused by a storage error. Check disk space and permissions; queued events will be retried.";
  }
  if (before !== ingestionError) changed();
}
function snapshot(): Snapshot {
  const sources = store.sources();
  return {
    settings: store.settings(),
    projects: store.projects(),
    chats: store.chats(),
    sources,
    workspaces: store.workspaces(),
    demo,
    dataDirectory: dataRoot(),
    ingestionError,
    setups: Object.fromEntries(
      sources.map((s) => [s.id, sourceSetup(dataRoot(), s, process.platform, connection)]),
    ),
  };
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
  handle("deck:load", () => snapshot());
  handle("deck:activity", (input) => store.activity(idSchema.parse(input)));
  handle("deck:copy", (input) =>
    clipboard.writeText(z.string().max(100000).parse(input)),
  );
  handle("deck:open-ticket", async (input) => {
    const url = resolveTicketUrl(store.chat(idSchema.parse(input)), store.settings());
    if (url) await shell.openExternal(url);
  });
  handle("deck:command", (input) => {
    const command = commandSchema.parse(input);
    if (command.type === "setDemo") {
      if (command.enabled !== demo) {
        const previous = demo;
        store.close();
        demo = command.enabled;
        try {
          openStore();
        } catch (error) {
          demo = previous;
          openStore();
          throw error;
        }
      }
    } else if (command.type === "advanceDemo") {
      if (!demo)
        throw new Error("Sample transitions are available only in demo mode");
      advanceDemo(store);
    } else if (command.type === "testSource") {
      inbox.test(command.id);
    } else {
      const previous = new Set(store.sources().map((s) => s.id));
      store.command(command);
      if (command.type === "createSource") {
        for (const source of store
          .sources()
          .filter((s) => !previous.has(s.id))) {
          try {
            writeHookSetup(dataRoot(), source, connection);
          } catch {
            store.sourceError(
              source.id,
              "HTTP hook setup failed. Restart the app after checking directory permissions.",
            );
          }
        }
      }
    }
    changed();
    return snapshot();
  });
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
      receiver = new HookReceiver(() => ({ store, inbox, root: dataRoot(), demo }));
      connection = await receiver.listen();
      openStore();
      registerIpc();
      createWindow();
      timer = setInterval(pollInbox, 1000);
      pollInbox();
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
    if (timer) clearInterval(timer);
    receiver?.server.close();
    receiver?.server.closeAllConnections();
    store?.close();
  });
}
