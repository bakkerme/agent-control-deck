import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { fork } from "node:child_process";
import { resolve } from "node:path";

type LaunchOptions = {
  dataDirectory: string;
  demo?: boolean;
  // Exercise notifications arriving before a slower command reply, as on CI.
  commandReplyDelayMs?: number;
};
interface RendererApp {
  firstWindow(): Promise<Page>;
  resize(width: number, height: number): Promise<void>;
  openedUrls(): Promise<string[]>;
  close(): Promise<void>;
}

async function launch(
  browser: Browser,
  options: LaunchOptions,
): Promise<RendererApp> {
  // Only Electron's Node runtime is used: no app, Dock icon or BrowserWindow.
  const child = fork(
    resolve("out-tests/renderer-backend.cjs"),
    [options.dataDirectory, options.demo ? "demo" : "workspace"],
    {
      execPath: require("electron") as string,
      execArgv: [],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ACD_HTTP_HOST: "127.0.0.1",
        ACD_HTTP_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output = (output + chunk).slice(-10000);
  });
  child.stderr?.on("data", (chunk) => {
    output = (output + chunk).slice(-10000);
  });
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let closing: Promise<void> | undefined;
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  const fail = (error: Error) => {
    readyReject(error);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code) =>
    fail(new Error(`Renderer backend exited (${code}). ${output}`)),
  );
  child.on(
    "message",
    (message: {
      ready?: boolean;
      changed?: boolean;
      id?: number;
      value?: unknown;
      error?: string;
    }) => {
      if (message.ready) readyResolve();
      if (message.changed && page && !page.isClosed()) {
        void page
          .evaluate(() => window.dispatchEvent(new Event("deck-test-changed")))
          .catch(() => {});
      }
      if (message.id !== undefined) {
        const call = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) call?.reject(new Error(message.error));
        else call?.resolve(message.value);
      }
    },
  );
  const invoke = (method: string, input?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.send({ id, method, input }, (error) => {
        if (error) {
          pending.delete(id);
          reject(error);
        }
      });
    });
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      try {
        await context?.close();
      } finally {
        if (child.connected) child.send({ method: "close" });
        const timeout = setTimeout(() => child.kill(), 5000);
        try {
          await exited;
        } finally {
          clearTimeout(timeout);
        }
      }
    })();
    return closing;
  };
  const startupTimeout = setTimeout(
    () => fail(new Error(`Renderer backend startup timed out. ${output}`)),
    15000,
  );
  try {
    await ready;
    clearTimeout(startupTimeout);
    context = await browser.newContext({
      viewport: { width: 1320, height: 850 },
    });
    await context.exposeBinding(
      "deckTestInvoke",
      async (_source, method: string, input?: unknown) => {
        const value = await invoke(method, input);
        if (method === "command" && options.commandReplyDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.commandReplyDelayMs),
          );
        }
        return value;
      },
    );
    await context.addInitScript(() => {
      const invoke = (
        window as unknown as {
          deckTestInvoke(method: string, input?: unknown): Promise<any>;
        }
      ).deckTestInvoke;
      window.deck = {
        saveMatching: (input) => invoke("saveMatching", input),
        removeMatchingKey: () => invoke("removeMatchingKey"),
        testMatchingConnection: () => invoke("testMatchingConnection"),
        load: () => invoke("load"),
        command: (input) => invoke("command", input),
        activity: (id) => invoke("activity", id),
        copy: (text) => invoke("copy", text),
        openTicket: (id) => invoke("openTicket", id),
        openLink: (id) => invoke("openLink", id),
        openPlanLink: (itemId, url) => invoke("openPlanLink", { itemId, url }),
        openPlanTicket: (itemId, key) =>
          invoke("openPlanTicket", { itemId, key }),
        onChanged: (callback) => {
          window.addEventListener("deck-test-changed", callback);
          return () =>
            window.removeEventListener("deck-test-changed", callback);
        },
      };
    });
    page = await context.newPage();
    await page.goto("http://127.0.0.1:4173");
    await expect(
      page.getByRole("button", { name: "Today", exact: true }),
    ).toBeVisible();
    return {
      firstWindow: async () => page!,
      resize: (width, height) => page!.setViewportSize({ width, height }),
      openedUrls: async () => (await invoke("openedUrls")) as string[],
      close,
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(startupTimeout);
  }
}

export const test = base.extend<{
  launchRenderer(options: LaunchOptions): Promise<RendererApp>;
}>({
  launchRenderer: async ({ browser }, use) => {
    const apps: RendererApp[] = [];
    try {
      await use(async (options) => {
        const app = await launch(browser, options);
        apps.push(app);
        return app;
      });
    } finally {
      await Promise.all(apps.map((app) => app.close()));
    }
  },
});
export { expect };
