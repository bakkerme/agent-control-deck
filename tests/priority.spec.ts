import { test, expect } from "./renderer-fixture";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test("sidebar priority flags highlight actionable chats across filters and persist with pencil renames", async ({
  launchRenderer,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "acd-priority-"));
  const launch = () => launchRenderer({ dataDirectory: dir });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const initial = await page.evaluate(() =>
      window.deck.command({
        type: "createSource",
        name: "Priority Claude",
        provider: "claude",
        environment: "native",
      }),
    );
    const source = initial.sources[0];
    let sequence = 0;
    const base = Date.now();
    const emit = (
      hook: string,
      session = "priority",
      extra: Record<string, unknown> = {},
    ) =>
      writeFileSync(
        join(initial.setups[source.id].inbox, `${randomUUID()}.json`),
        JSON.stringify({
          version: 1,
          eventId: randomUUID(),
          observedAt: new Date(base + ++sequence).toISOString(),
          payload: {
            hook_event_name: hook,
            session_id: session,
            cwd: session === "other" ? "/work/other" : "/work/priority-repo",
            ...extra,
          },
        }),
      );
    emit("UserPromptSubmit", "priority", { prompt: "Release task" });
    emit("UserPromptSubmit", "other", { prompt: "Other task" });
    const task = () =>
      page.getByRole("button", {
        name: "Select chat Release task",
        exact: true,
      });
    const sidebar = () => page.locator(".projects");
    const repoFlag = () =>
      sidebar().getByRole("button", {
        name: "Priority repository priority-repo",
        exact: true,
      });
    const repoRow = () =>
      sidebar()
        .locator(".project-row")
        .filter({
          has: page.getByRole("button", {
            name: "Priority repository priority-repo",
            exact: true,
          }),
        });
    await expect(task()).toBeVisible();
    await expect(repoFlag()).toHaveAttribute("aria-pressed", "false");
    await repoFlag().focus();
    await page.keyboard.press("Space");
    await expect(repoFlag()).toHaveAttribute("aria-pressed", "true");
    await expect(task()).not.toHaveClass(/priority-attention/);
    await expect(repoRow().locator(".priority-lamp")).toHaveCount(0);
    await expect(
      repoRow().getByRole("button", {
        name: "Rename repository priority-repo",
        exact: true,
      }),
    ).toBeVisible();

    emit("SubagentStart", "priority", {
      agent_id: "worker",
      agent_type: "Explore",
    });
    emit("Stop", "priority", { last_assistant_message: "Parent finished" });
    await expect(task().locator(".status")).toHaveText(/Main turn finished/);
    await expect(task()).not.toHaveClass(/priority-attention/);
    emit("SubagentStop", "priority", { agent_id: "worker" });
    await expect(task()).toHaveClass(/priority-attention/);
    await expect(task()).toHaveAttribute(
      "aria-description",
      "Priority repository · Turn finished",
    );
    await expect(repoRow().locator(".priority-lamp")).toBeVisible();

    await expect(
      page.getByRole("button", { name: "Select chat Other task", exact: true }),
    ).not.toHaveClass(/priority-attention/);
    await page.getByRole("button", { name: /^other 1$/ }).click();
    await expect(task()).toHaveCount(0);
    await expect(repoRow().locator(".priority-lamp")).toBeVisible();
    await page.getByRole("button", { name: /^All repositories 2$/ }).click();

    const snapshot = await page.evaluate(() => window.deck.load());
    const chat = snapshot.chats.find((c) => c.externalId === "priority")!;
    emit("Notification", "priority", {
      notification_type: "permission_prompt",
      message: "Needs input",
    });
    await expect(task()).toHaveAttribute(
      "aria-description",
      "Priority repository · Needs input",
    );
    await task().click();
    await page.screenshot({ path: "test-results/project-priority.png" });
    await sidebar()
      .getByRole("button", {
        name: "Rename repository priority-repo",
        exact: true,
      })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .fill("priority-repo");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save name", exact: true })
      .click();
    await app.resize(980, 650);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(980);
    await expect
      .poll(() =>
        sidebar().evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return Array.from(element.querySelectorAll("button")).every(
            (button) => {
              const box = button.getBoundingClientRect();
              return box.left >= bounds.left && box.right <= bounds.right;
            },
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: "test-results/project-priority-minimum.png",
    });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(repoFlag()).toHaveAttribute("aria-pressed", "true");
    await expect(task()).toHaveClass(/priority-attention/);
    emit("UserPromptSubmit", "priority", { prompt: "Release task" });
    await expect(task().locator(".status")).toHaveText("Running");
    await expect(task()).not.toHaveClass(/priority-attention/);
    await expect(sidebar().locator(".priority-lamp")).toHaveCount(0);
    emit("SessionEnd");
    await expect(task()).toHaveAttribute(
      "aria-description",
      "Priority repository · Session ended",
    );
    await page.evaluate(
      (id) =>
        window.deck.command({
          type: "updateChat",
          id,
          patch: { archived: true },
        }),
      chat.id,
    );
    await expect(sidebar().locator(".priority-lamp")).toHaveCount(0);
    await page.getByRole("button", { name: /^Archived chats 1$/ }).click();
    await expect(task()).not.toHaveClass(/priority-attention/);
    await page.evaluate(
      (id) =>
        window.deck.command({
          type: "updateChat",
          id,
          patch: { archived: false },
        }),
      chat.id,
    );
    await page.getByRole("button", { name: /^Active chats 2$/ }).click();
    await expect(task()).toHaveClass(/priority-attention/);
    await repoFlag().click();
    await expect(repoFlag()).toHaveAttribute("aria-pressed", "false");
    await expect(task()).not.toHaveClass(/priority-attention/);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
