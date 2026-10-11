import { test, expect } from "./renderer-fixture";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("live permissions use Spotlight, questions use the dock, and successful responses immediately dismiss", async ({ launchRenderer }) => {
  const dir = mkdtempSync(join(tmpdir(),"acd-actions-ui-"));
  const app = await launchRenderer({ dataDirectory: dir });
  try {
    const page = await app.firstWindow();
    await app.resize(980,650);
    const snapshot = await page.evaluate(async () => {
      const created = await window.deck.command({ type: "createSource", name: "My Claude", provider: "claude", environment: "native" });
      return window.deck.command({ type: "setSourceResponses", id: created.sources[0].id, enabled: true });
    });
    const hooks = JSON.parse(snapshot.setups[snapshot.sources[0].id].config).hooks;
    const send = (event: "PermissionRequest" | "PreToolUse", id: string, tool_input: Record<string,unknown>) => {
      const hook = hooks[event][0].hooks[0];
      return fetch(hook.url,{ method:"POST", headers: { ...hook.headers,"Content-Type":"application/json" }, body: JSON.stringify({ hook_event_name:event, session_id:"ux-session", tool_use_id:id, cwd:"/work/deck", tool_name:event === "PermissionRequest" ? "Bash" : "AskUserQuestion", tool_input }) }).then(r => r.text());
    };
    const allowed = send("PermissionRequest","allow",{ command:"git status",description:"Inspect changes" });
    const modal = page.getByRole("dialog",{ name:"Permission request" });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("button",{ name:"Keep waiting" })).toBeFocused();
    await expect(modal.locator("pre").first()).toHaveText("git status");
    await modal.getByRole("button",{ name:"Keep waiting" }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole("button",{ name:"Review permission" })).toBeVisible();
    await page.getByRole("button",{ name:"Review permission" }).click();
    await modal.getByRole("button",{ name:"Allow once" }).click();
    expect(JSON.parse(await allowed).hookSpecificOutput.decision.behavior).toBe("allow");
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("Allowed");

    const first = send("PermissionRequest","first",{ command:"npm test" });
    await expect(modal).toBeVisible();
    const second = send("PermissionRequest","second",{ command:"npm run build" });
    await expect(page.getByText("2 permission requests waiting",{ exact:true })).toBeVisible();
    await modal.getByRole("button",{ name:"Deny", exact:true }).click();
    expect(JSON.parse(await first).hookSpecificOutput.decision.behavior).toBe("deny");
    await expect(modal).toHaveCount(0); // Never automatically advance to another approval.
    await page.getByRole("button",{ name:"Review permission" }).click();
    await expect(modal.locator("pre").first()).toHaveText("npm run build");
    await modal.getByRole("button",{ name:"Deny", exact:true }).click();
    await second;

    const choices = [{ label:"Spotlight",description:"Immediate permission prompt" },{ label:"Dock",description:"Answer beside your work" }];
    const answer = send("PreToolUse","question-one",{ questions:[{ header:"Layout",question:"Where should questions appear?",options:choices }] });
    const dock = page.getByRole("complementary",{ name:"Questions",exact:true });
    await expect(dock).toBeVisible();
    await page.getByRole("button",{ name:"Repositories",exact:true }).click();
    await expect(dock).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const bounds = await dock.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(981);
    await dock.getByRole("button",{ name:/^Dock/ }).click();
    expect(JSON.parse(await answer).hookSpecificOutput.updatedInput.answers).toEqual({ "Where should questions appear?":"Dock" });
    await expect(dock).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText:"Answer sent" })).toBeVisible();

    const custom = send("PreToolUse","question-custom",{ questions:[{ header:"Layout",question:"What should happen next?",options:choices }] });
    await expect(dock).toBeVisible();
    await dock.getByLabel("Your own answer").fill("Keep my draft through retries");
    await page.evaluate(() => {
      const respond = window.deck.respond;
      let fail = true;
      window.deck.respond = input => { if (fail) { fail = false; return Promise.reject(new Error("Temporary delivery failure")); } return respond(input); };
    });
    await dock.getByRole("button",{ name:"Send answer" }).click();
    await expect(dock.getByRole("alert")).toContainText("Temporary delivery failure");
    await expect(dock.getByLabel("Your own answer")).toHaveValue("Keep my draft through retries");
    await dock.getByLabel("Your own answer").fill("Use my revised answer");
    await page.getByRole("button",{ name:"Sources",exact:true }).click();
    await expect(page.getByRole("checkbox",{ name:"Answer questions and permissions in the deck" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button",{ name:"Today",exact:true }).click();
    await expect(dock.getByLabel("Your own answer")).toHaveValue("Use my revised answer");
    await page.screenshot({ path:"test-results/question-dock.png" });
    await dock.getByRole("button",{ name:"Retry",exact:true }).click();
    expect(JSON.parse(await custom).hookSpecificOutput.updatedInput.answers).toEqual({ "What should happen next?":"Use my revised answer" });
    await expect(dock).toHaveCount(0);
    await expect(page.getByText("Response received",{ exact:true })).toHaveCount(0);
  } finally { await app.close(); rmSync(dir,{ recursive:true,force:true }); }
});

test("batched questions require a complete answer and keep drafts when switching queued requests", async ({ launchRenderer }) => {
  const dir = mkdtempSync(join(tmpdir(),"acd-actions-batch-"));
  const app = await launchRenderer({ dataDirectory:dir });
  try {
    const page = await app.firstWindow();
    const snapshot = await page.evaluate(async () => {
      const s = await window.deck.command({ type:"createSource",name:"Claude",provider:"claude",environment:"native" });
      return window.deck.command({ type:"setSourceResponses",id:s.sources[0].id,enabled:true });
    });
    const hook = JSON.parse(snapshot.setups[snapshot.sources[0].id].config).hooks.PreToolUse[0].hooks[0];
    const options = [{ label:"Dock",description:"Use the dock" },{ label:"Spotlight",description:"Use Spotlight" }];
    const send = (session_id: string, questions: unknown[]) => fetch(hook.url,{ method:"POST",headers:{ ...hook.headers,"Content-Type":"application/json" },body:JSON.stringify({ hook_event_name:"PreToolUse",session_id,tool_name:"AskUserQuestion",tool_input:{ questions,metadata:{ retained:true } } }) }).then(async r => { const text = await r.text(); return text ? JSON.parse(text) : null; });
    const first = send("first-request",[{ header:"Channels",question:"Which channels?",options,multiSelect:true },{ header:"Default",question:"Which default?",options }]);
    const dock = page.getByRole("complementary",{ name:"Questions",exact:true });
    await expect(dock).toBeVisible();
    await dock.getByRole("checkbox",{ name:/^Dock/ }).check();
    await dock.getByRole("checkbox",{ name:/^Spotlight/ }).check();
    await expect(dock.getByRole("button",{ name:"Send answer" })).toBeDisabled();
    await dock.getByRole("radio",{ name:/^Dock/ }).check();
    const second = send("second-request",[{ header:"Follow-up",question:"What next?",options }]);
    await dock.getByRole("navigation",{ name:"Waiting questions" }).getByRole("button",{ name:"Claude Code · second-request" }).click();
    const activeQuestion = dock.locator(".question-request:visible");
    await activeQuestion.getByLabel("Your own answer").fill("Save this draft");
    await dock.getByRole("navigation",{ name:"Waiting questions" }).getByRole("button",{ name:"Claude Code · first-request" }).click();
    await expect(dock.getByRole("checkbox",{ name:/^Spotlight/ })).toBeChecked();
    await expect(dock.getByRole("radio",{ name:/^Dock/ })).toBeChecked();
    await dock.getByRole("button",{ name:"Send answer" }).click();
    expect((await first).hookSpecificOutput.updatedInput).toMatchObject({ metadata:{ retained:true },answers:{ "Which channels?":"Dock, Spotlight","Which default?":"Dock" } });
    await expect(dock.getByRole("group",{ name:"Which channels?" })).toHaveCount(0);
    await expect(activeQuestion.getByLabel("Your own answer")).toHaveValue("Save this draft");
    await dock.getByRole("button",{ name:"Send answer" }).click();
    expect((await second).hookSpecificOutput.updatedInput.answers).toEqual({ "What next?":"Save this draft" });
    await expect(dock).toHaveCount(0);
  } finally { await app.close(); rmSync(dir,{ recursive:true,force:true }); }
});

test("disable and demo switching return pending requests neutrally and persist the opt-in setting", async ({ launchRenderer }) => {
  const dir = mkdtempSync(join(tmpdir(),"acd-actions-state-"));
  let app = await launchRenderer({ dataDirectory:dir });
  try {
    let page = await app.firstWindow();
    let snapshot = await page.evaluate(async () => {
      const created = await window.deck.command({ type:"createSource",name:"Claude",provider:"claude",environment:"native" });
      return window.deck.command({ type:"setSourceResponses",id:created.sources[0].id,enabled:true });
    });
    const send = () => {
      const hook = JSON.parse(snapshot.setups[snapshot.sources[0].id].config).hooks.PermissionRequest[0].hooks[0];
      return fetch(hook.url,{ method:"POST",headers:{ ...hook.headers,"Content-Type":"application/json" },body:JSON.stringify({ hook_event_name:"PermissionRequest",session_id:"state",tool_name:"Bash",tool_input:{ command:"git status" } }) }).then(r => r.text());
    };
    let pending = send();
    await expect(page.getByRole("dialog",{ name:"Permission request" })).toBeVisible();
    await page.evaluate(async id => window.deck.command({ type:"setSourceResponses",id,enabled:false }),snapshot.sources[0].id);
    expect(await pending).toBe("");
    await expect(page.getByRole("dialog",{ name:"Permission request" })).toHaveCount(0);
    snapshot = await page.evaluate(async id => window.deck.command({ type:"setSourceResponses",id,enabled:true }),snapshot.sources[0].id);
    pending = send();
    await expect(page.getByRole("dialog",{ name:"Permission request" })).toBeVisible();
    await page.evaluate(() => window.deck.command({ type:"setDemo",enabled:true }));
    expect(await pending).toBe("");
    await expect(page.getByRole("dialog",{ name:"Permission request" })).toHaveCount(0);
    await page.evaluate(() => window.deck.command({ type:"setDemo",enabled:false }));
    await app.close();
    app = await launchRenderer({ dataDirectory:dir });
    page = await app.firstWindow();
    const restored = await page.evaluate(() => window.deck.load());
    expect(restored.sources[0].responsesEnabled).toBe(true);
    expect(restored.requests).toEqual([]);
    await page.getByRole("button",{ name:"Sources",exact:true }).click();
    await expect(page.getByRole("checkbox",{ name:"Answer questions and permissions in the deck" })).toBeChecked();
  } finally { await app.close(); rmSync(dir,{ recursive:true,force:true }); }
});
