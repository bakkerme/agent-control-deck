import { notesField, organizationField, organizationButton } from "./ui-helpers";
import { test, expect, _electron as electron } from "@playwright/test";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("desktop CRUD, live events, archive, search, demo isolation, and restart persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-ui-"));
  const launch = () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
      ),
    ) as Record<string, string>;
    return electron.launch({
      executablePath: process.env.ACD_PACKAGED_EXECUTABLE,
      args: [
        ...(process.env.ACD_PACKAGED_EXECUTABLE ? [] : [resolve(".")]),
        `--data-dir=${dir}`,
      ],
      env: { ...env, ACD_HTTP_PORT: "0" },
    });
  };
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(
      page.getByRole("heading", { name: "Agent Control Deck", exact: true }),
    ).toBeVisible();
    // A fresh workspace must allow chats before any projects exist.
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("combobox", { name: "Project", exact: true })).toHaveValue("");
    await page.getByRole("dialog").getByLabel("Chat name").fill("Standalone task");
    await page.getByRole("dialog").getByRole("button", { name: "Create chat", exact: true }).click();
    await (await notesField(page)).fill("Keep my standalone notes");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await expect(page.getByRole("button", { name: /^No project 1$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename project", exact: true })).toHaveCount(0);
    await page
      .getByRole("button", { name: "+ Add a new project", exact: true })
      .click();
    await page.getByLabel("Project name", { exact: true }).fill("Work project");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await expect(page.getByRole("navigation", { name: "Projects", exact: true }).locator("button").last()).toHaveText("+ Add a new project");
    await expect(page.getByRole("button", { name: /^Work project 0$/ })).toHaveClass("selected");
    await page.getByRole("button", { name: /^No project 1$/ }).click();
    // Assigning and removing a project moves the same chat between filters.
    await (await organizationField(page, "Project")).selectOption({ label: "Work project" });
    await expect(page.getByRole("status")).toHaveText("Saved");
    await expect(page.getByRole("button", { name: "Select chat Standalone task" })).toHaveCount(0);
    await page.getByRole("button", { name: /^Work project 1$/ }).click();
    await expect(page.getByRole("button", { name: "Select chat Standalone task" })).toBeVisible();
    await (await organizationField(page, "Project")).selectOption("");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await expect(page.getByRole("button", { name: "Select chat Standalone task" })).toHaveCount(0);
    await page.getByRole("button", { name: /^No project 1$/ }).click();
    await expect(page.getByRole("button", { name: "Select chat Standalone task" })).toBeVisible();
    await expect((await notesField(page))).toHaveValue("Keep my standalone notes");
    await (await organizationButton(page, "Archive chat")).click();
    await expect(page.getByRole("button", { name: /^No project 0$/ })).toBeVisible();
    await page.getByRole("button", { name: /^Archived chats \d+$/ }).click();
    await expect(page.getByRole("button", { name: "Select chat Standalone task" })).toBeVisible();
    await (await organizationButton(page, "Restore chat")).click();
    await page.getByRole("button", { name: /^Active chats \d+$/ }).click();
    await page.getByRole("button", { name: /^Work project 0$/ }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("combobox", { name: "Project", exact: true })).not.toHaveValue("");
    await page
      .getByRole("dialog")
      .getByLabel("Chat name")
      .fill("Investigate retries");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create chat", exact: true })
      .click();
    await expect(page.getByLabel("Chat details").getByRole("heading", { name: "Investigate retries", exact: true })).toBeVisible();
    await (await notesField(page))
      .fill("Check retry limits before changing the API.");
    await page.getByRole("button", { name: "Add ticket", exact: true }).click();
    await page.getByLabel("Ticket number or full URL")
      .fill("https://jira.example/browse/WORK-42");
    await page.getByLabel("Ticket number or full URL").press("Enter");
    await expect(page.getByRole("status")).toHaveText("Saved");
    // Invalid fields must keep drafts visible and prevent navigation until fixed.
    await page.getByRole("button", { name: "Edit ticket", exact: true }).click();
    await page.getByLabel("Ticket number or full URL")
      .fill("javascript:alert(1)");
    await (await notesField(page))
      .fill("Check retry limits before changing the API.");
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "complete http:// or https:// URL",
    );
    await expect(page.getByLabel("Chat details")).toBeVisible();
    await page.getByLabel("Ticket number or full URL")
      .fill("https://jira.example/browse/WORK-42");
    await page.getByLabel("Ticket number or full URL").press("Enter");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await (await organizationField(page, "Manual state")).selectOption("waiting");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await page.getByLabel("Search chats").fill("WORK-42");
    await expect(
      page.getByRole("button", { name: "Select chat Investigate retries" }),
    ).toBeVisible();
    await (await organizationButton(page, "Archive chat"))
      .click();
    await expect(
      page.getByRole("button", { name: "Select chat Investigate retries" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: /^Archived chats \d+$/ }).click();
    await expect(
      page.getByRole("button", { name: "Select chat Investigate retries" }),
    ).toBeVisible();
    await (await organizationButton(page, "Restore chat"))
      .click();
    await page.getByRole("button", { name: /^Active chats \d+$/ }).click();
    await page.getByLabel("Search chats").fill("");
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    await page.getByLabel("Source name").fill("Local Claude");
    await page
      .getByRole("button", { name: "Create source", exact: true })
      .click();
    await expect(page.getByLabel("Hook configuration")).toContainText(
      "UserPromptSubmit",
    );
    await page.getByRole("button", { name: "Send diagnostic event" }).click();
    await expect(page.getByText(/1 accepted/)).toBeVisible();
    const snapshot = await page.evaluate(() => window.deck.load());
    const source = snapshot.sources[0];
    const hook = JSON.parse(snapshot.setups[source.id].config).hooks.UserPromptSubmit[0].hooks[0];
    const endpoint = snapshot.setups[source.id].endpoint;
    const emit = async (event: string, extra: Record<string, string> = {}) => {
      const response = await fetch(`${endpoint}/${event}`, { method: "POST", headers: { ...hook.headers, "Content-Type": "application/json" }, body: JSON.stringify({ hook_event_name: event, session_id: "ui-live", cwd: "/work/project", ...extra }) });
      expect(response.status).toBe(200);
    };
    await emit("UserPromptSubmit", { prompt: "Live integration fixture" });
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByRole("button", { name: /^All projects/ }).click();
    await expect(
      page.getByRole("button", {
        name: "Select chat Live integration fixture",
      }),
    ).toBeVisible({ timeout: 5000 });
    await page
      .getByRole("button", { name: "Select chat Live integration fixture" })
      .click();
    await (await organizationField(page, "Chat name")).fill("Named live task");
    await (await notesField(page))
      .fill("User notes survive provider updates");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await (await organizationField(page, "Project")).selectOption("");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await emit("Stop", { last_assistant_message: "Ready for review" });
    await expect(
      page.getByText("Ready for review", { exact: true }).last(),
    ).toBeVisible();
    await expect((await notesField(page))).toHaveValue(
      "User notes survive provider updates",
    );
    await emit("SessionEnd", { reason: "prompt_input_exit" });
    await expect(
      page.getByLabel("Chat details").getByText("Ended", { exact: true }),
    ).toBeVisible();
    expect((await page.evaluate(() => window.deck.load())).chats.find((c) => c.name === "Named live task")?.projectId).toBeNull();
    await page.getByRole("button", { name: "Try demo", exact: true }).click();
    await expect(
      page.getByText("Demo workspace · separate sample data"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Select chat Named live task" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: /^No project 1$/ }).click();
    await page.getByRole("button", { name: "Select chat Explore a standalone idea" }).click();
    await expect((await organizationField(page, "Project"))).toHaveValue("");
    await (await organizationField(page, "Project")).selectOption({ label: "Customer portal" });
    await expect(page.getByRole("status")).toHaveText("Saved");
    await expect(page.getByRole("button", { name: /^No project 0$/ })).toBeVisible();
    await (await organizationField(page, "Project")).selectOption("");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await expect(page.getByRole("button", { name: "Select chat Explore a standalone idea" })).toBeVisible();
    await page.getByRole("button", { name: "Next sample event" }).click();
    await page.getByRole("button", { name: "Leave demo" }).click();
    await expect(
      page.getByRole("button", { name: "Select chat Named live task" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Select chat Named live task" })
      .click();
    await page.screenshot({
      path: "test-results/desktop-workspace.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole("button", { name: "Select chat Standalone task" }).click();
    await expect((await organizationField(page, "Project"))).toHaveValue("");
    await expect((await notesField(page))).toHaveValue("Keep my standalone notes");
    await page
      .getByRole("button", { name: "Select chat Investigate retries" })
      .click();
    await expect((await notesField(page))).toHaveValue(
      "Check retry limits before changing the API.",
    );
    await expect(page.getByRole("button", { name: "Open Jira ticket WORK-42", exact: true })).toHaveText(
      "WORK-42",
    );
    await expect((await organizationField(page, "Manual state"))).toHaveValue("waiting");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
