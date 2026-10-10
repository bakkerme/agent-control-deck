import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

test("long project names use the full row while hover controls overlay without shifting it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-project-layout-"));
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
    const names = [
      "agent-control-deck",
      "agent-control-deck-desktop-integrations",
      "agent-control-deck-desktop-integrations-windows-wsl",
    ];
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    const initial = await page.evaluate(() =>
      window.deck.command({
        type: "createSource",
        name: "Layout",
        provider: "claude",
        environment: "native",
      }),
    );
    for (const name of names)
      writeFileSync(
        join(
          initial.setups[initial.sources[0].id].inbox,
          `${randomUUID()}.json`,
        ),
        JSON.stringify({
          version: 1,
          eventId: randomUUID(),
          payload: {
            hook_event_name: "UserPromptSubmit",
            session_id: name,
            cwd: `/work/${name}`,
            prompt: name,
          },
        }),
      );
    await expect(page.locator(".project-row")).toHaveCount(5);
    const rowFor = (name: string) =>
      page
        .locator(".project-row")
        .filter({ has: page.getByText(name, { exact: true }) });
    const heading = page.getByRole("heading", {
      name: "Repositories",
      exact: true,
    });
    for (const width of [1280, 980]) {
      await app.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0].setSize(width, 650),
        width,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      await heading.hover();
      for (const name of names) {
        const row = rowFor(name);
        const label = row.locator(".project-name");
        const controls = row.locator(".project-tools");
        await expect(controls).toHaveCSS("opacity", "0");
        await expect(label).toHaveAttribute("title", name);
        // The navigation button gets the entire row; hidden tools reserve no width.
        const geometry = await row.evaluate((element) => {
          const row = element.getBoundingClientRect();
          const button = element
            .querySelector("button")!
            .getBoundingClientRect();
          const label = element.querySelector<HTMLElement>(".project-name")!;
          return {
            rowWidth: row.width,
            buttonWidth: button.width,
            nameWidth: label.clientWidth,
            textWidth: label.scrollWidth,
          };
        });
        expect(geometry.buttonWidth).toBe(geometry.rowWidth);
        if (name === "agent-control-deck")
          expect(geometry.textWidth).toBeLessThanOrEqual(geometry.nameWidth);
        else {
          expect(geometry.textWidth).toBeGreaterThan(geometry.nameWidth);
          await expect(label).toHaveCSS("text-overflow", "ellipsis");
          await expect(label).toHaveCSS("white-space", "nowrap");
        }
        const before = await label.boundingBox();
        await row.hover();
        await expect(controls).toHaveCSS("opacity", "1");
        expect(await label.boundingBox()).toEqual(before);
        expect(
          await controls.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const name = element
              .parentElement!.querySelector(".project-name")!
              .getBoundingClientRect();
            const style = getComputedStyle(element);
            const button = element.querySelector("button")!;
            const target = button.getBoundingClientRect();
            return {
              coversName: box.left < name.right && box.right > name.left,
              opaque: style.backgroundColor === "rgb(255, 255, 255)",
              bordered:
                style.borderTopStyle === "solid" &&
                parseFloat(style.borderTopWidth) > 0,
              clickable:
                document
                  .elementFromPoint(
                    target.x + target.width / 2,
                    target.y + target.height / 2,
                  )
                  ?.closest("button") === button,
            };
          }),
        ).toEqual({
          coversName: true,
          opaque: true,
          bordered: true,
          clickable: true,
        });
        await heading.hover();
        await expect(controls).toHaveCSS("opacity", "0");
      }
      const sidebarBounds = (await page.locator(".projects").boundingBox())!;
      await page.screenshot({
        path: `test-results/project-names-${width}.png`,
        clip: sidebarBounds,
      });
      await rowFor(names[1]).hover();
      await expect(rowFor(names[1]).locator(".project-tools")).toHaveCSS(
        "opacity",
        "1",
      );
      await page.screenshot({
        path: `test-results/project-names-hover-${width}.png`,
        clip: sidebarBounds,
      });
    }
    await heading.hover();
    const row = rowFor(names[1]);
    await row.locator(":scope > button").focus();
    await expect(row.locator(".project-tools")).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(
      row.getByRole("button", {
        name: `Rename repository ${names[1]}`,
        exact: true,
      }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    const flag = row.getByRole("button", {
      name: `Priority repository ${names[1]}`,
      exact: true,
    });
    await expect(flag).toBeFocused();
    await page.keyboard.press("Space");
    await expect(flag).toHaveAttribute("aria-pressed", "true");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repository labels and legacy context persist while real worktrees share their repository", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "acd-projects-")));
  const root = join(dir, "agent-control-deck"),
    worktree = join(dir, "temporary-worktree");
  execFileSync("git", ["init", "--initial-branch=main", root], {
    stdio: "pipe",
  });
  execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture",
    ],
    { stdio: "pipe" },
  );
  execFileSync("git", ["-C", root, "worktree", "add", "--detach", worktree], {
    stdio: "pipe",
  });
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
    const initial = await page.evaluate(() =>
      window.deck.command({
        type: "createSource",
        name: "Local Claude",
        provider: "claude",
        environment: "native",
      }),
    );
    const source = initial.sources[0];
    const emit = (
      session: string,
      prompt: string,
      cwd = root,
      hook = "UserPromptSubmit",
    ) =>
      writeFileSync(
        join(initial.setups[source.id].inbox, `${randomUUID()}.json`),
        JSON.stringify({
          version: 1,
          eventId: randomUUID(),
          payload: { hook_event_name: hook, session_id: session, cwd, prompt },
        }),
      );
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    const task = () =>
      page.getByRole("button", {
        name: "Select chat First repo task",
        exact: true,
      });
    emit("first", "First repo task");
    await task().click();
    const repo = (await page.evaluate(() => window.deck.load())).projects.find(
      (p) => p.name === "agent-control-deck",
    )!;
    await page
      .locator(".projects")
      .getByRole("button", {
        name: "Rename repository agent-control-deck",
        exact: true,
      })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .fill("Repository label");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save name", exact: true })
      .click();
    await page
      .locator(".projects")
      .getByRole("button", {
        name: "Priority repository Repository label",
        exact: true,
      })
      .click();
    emit("first", "First repo task", root, "Stop");
    await expect(task()).toHaveClass(/priority-attention/);
    // Legacy custom memberships remain stored, but repo browsing uses detected repository context.
    const legacy = await page.evaluate(() =>
      window.deck.command({ type: "createProject", name: "Release planning" }),
    );
    const custom = legacy.projects.find((p) => p.name === "Release planning")!;
    const chat = legacy.chats.find((c) => c.externalId === "first")!;
    await page.evaluate(
      ({ id, projectId }) =>
        window.deck.command({ type: "updateChat", id, patch: { projectId } }),
      { id: chat.id, projectId: custom.id },
    );
    emit("first", "First repo task", worktree);
    emit("second", "New worktree task", worktree);
    await expect(
      page.getByRole("button", { name: /^Repository label 2$/ }),
    ).toBeVisible();
    await expect(page.locator(".project-row")).toHaveCount(3);
    await page.getByRole("button", { name: /^Repository label 2$/ }).click();
    await expect(task()).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Select chat New worktree task",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/repository-worktrees.png" });
    await task().click();
    await page
      .getByRole("region", { name: "Chat organization" })
      .getByRole("button", { name: "Archive chat", exact: true })
      .click();
    await page.getByRole("button", { name: /^Archived chats 1$/ }).click();
    await expect(
      page.getByRole("button", { name: /^Repository label 1$/ }),
    ).toBeVisible();
    await task().click();
    await page
      .getByRole("region", { name: "Chat organization" })
      .getByRole("button", { name: "Restore chat", exact: true })
      .click();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    await page.getByRole("button", { name: /^Repository label 2$/ }).click();
    await task().click();
    await expect(
      page.getByRole("combobox", { name: "Project", exact: true }),
    ).toHaveCount(0);
    const saved = (await page.evaluate(() => window.deck.load())).chats.find(
      (c) => c.externalId === "first",
    )!;
    expect(saved.repoProjectId).toBe(repo.id);
    expect(saved.projectId).toBe(custom.id);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
