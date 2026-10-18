import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deferred } from "./embedded-fault-harness";

function processIdentity(pid: number) { try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[19]; } catch { return undefined; } }
function processState(pid: number) {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[0]; } catch { return undefined; }
}
for (const boundary of ["cancel", "close", "backendDeath"]) test(`actual parked-input SDK child terminates after ${boundary}`, { timeout: 20000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "acd-sdk-process-"));
  const child = fork(resolve("out-tests/sdk-process-worker.cjs"), [dir], { execPath: process.execPath, execArgv: [],
    env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const ready = deferred(), exited = deferred(); let sdkPid = 0, sdkIdentity: string | undefined;
  child.on("message", (m: any) => { if (m.sdkPid) { sdkPid = m.sdkPid; sdkIdentity = processIdentity(sdkPid); } if (m.ready) ready.resolve(); if (m.sdkExit) exited.resolve(); if (m.failed) ready.reject(new Error("SDK initialization failed")); });
  child.once("error", ready.reject);
  child.once("exit", () => { ready.reject(new Error("SDK worker exited before ready")); exited.reject(new Error("SDK worker exited before reporting SDK exit")); });
  void exited.promise.catch(() => {});
  t.after(async () => {
    if (sdkPid && sdkIdentity === processIdentity(sdkPid) && ![undefined, "Z"].includes(processState(sdkPid))) process.kill(sdkPid, "SIGKILL");
    const deadline = Date.now() + 3000;
    while (sdkPid && sdkIdentity === processIdentity(sdkPid) && ![undefined, "Z"].includes(processState(sdkPid)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(!sdkPid || sdkIdentity !== processIdentity(sdkPid) || [undefined, "Z"].includes(processState(sdkPid)), "tracked SDK process remains live after cleanup");
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGKILL"); await done; }
    rmSync(dir, { recursive: true, force: true });
  });
  await ready.promise; assert.ok(sdkPid); assert.notEqual(processState(sdkPid), undefined);
  if (boundary === "backendDeath") {
    const gone = once(child, "exit"); child.kill("SIGKILL"); await gone;
    const deadline = Date.now() + 10000;
    while (![undefined, "Z"].includes(processState(sdkPid)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok([undefined, "Z"].includes(processState(sdkPid)), "actual SDK child remained live after backend death");
    t.diagnostic(processState(sdkPid) === "Z" ? "SDK terminated; zombie awaits container PID1 reaping" : "SDK PID removed");
  } else { child.send(boundary); await exited.promise; assert.ok([undefined, "Z"].includes(processState(sdkPid))); child.send("stop"); }
});
