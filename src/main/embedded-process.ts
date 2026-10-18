// Backend only. Linux SDK and all orphaned descendants belong to one subreaper.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { version } from "../../package.json";
declare const __SDK_SUPERVISOR_SOURCE_HASH__: string;
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
type SpawnOptions = Parameters<NonNullable<Options["spawnClaudeCodeProcess"]>>[0];
export type OwnedSdkProcess = ChildProcessWithoutNullStreams & { sdkPid?: Promise<number>; ownedSupervisor?: boolean };
export function spawnOwnedSdkProcess(options: SpawnOptions): OwnedSdkProcess {
  if (process.platform !== "linux") return spawn(options.command, options.args, {
    cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const helper = join(__dirname, "../sdk-supervisor").replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
  verifySdkSupervisor(helper, typeof __SDK_SUPERVISOR_SOURCE_HASH__ === "undefined" ? undefined : __SDK_SUPERVISOR_SOURCE_HASH__);
  const child = spawn(helper, [String(process.pid), options.command, ...options.args], {
    cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"], windowsHide: true,
  }) as OwnedSdkProcess;
  child.ownedSupervisor = true;
  // fd 3 has a single backend-owned writer. A pidfd also watches the exact backend process, so inherited pipe writers
  // in Electron helpers cannot mask backend death. Neither depends on
  // JS cleanup, renderer liveness, SDK EOF or pipe backpressure.
  child.stdio[3]!.on("error", () => { child.kill("SIGTERM"); });
  child.sdkPid = new Promise<number>((resolve, reject) => {
    let text = "";
    const channel = child.stdio[4]!;
    channel.on("data", (part: Buffer) => { text += part.toString(); if (text.length > 32) channel.destroy(); });
    channel.once("end", () => /^ACD_SUPERVISOR_1 \d+\n$/.test(text) ? resolve(Number(text.trim().split(" ")[1])) : reject(new Error("SDK supervisor did not report startup")));
    channel.once("error", () => reject(new Error("SDK supervisor startup channel failed")));
    channel.once("close", () => { if (!/^ACD_SUPERVISOR_1 \d+\n$/.test(text)) reject(new Error("SDK supervisor startup channel closed")); });
    child.once("error", () => reject(new Error("SDK supervisor failed to start")));
  });
  void child.sdkPid.catch(() => { child.kill("SIGTERM"); });
  return child;
}

export function verifySdkSupervisor(helper: string, sourceHash: string | undefined): void {
  const manifest = JSON.parse(readFileSync(helper + ".json", "utf8"));
  if (manifest.protocol !== 1 || manifest.appVersion !== version || !sourceHash || manifest.sourceSha256 !== sourceHash || createHash("sha256").update(readFileSync(helper)).digest("hex") !== manifest.sha256) throw new Error("SDK supervisor integrity/version mismatch; rebuild or reinstall the app");
}
