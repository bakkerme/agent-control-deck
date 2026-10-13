import { spawn, fork, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { StringDecoder } from "node:string_decoder";
import { LOCAL_MODELS, localRequest, localOutput, type LocalModel, type LocalRuntimeStatus } from "../shared/local-matching";
import type { MatchPayload } from "../shared/chat-matching";
import { LocalMatchingError } from "./local-matching-error";

export function localPython(root: string, model: LocalModel, platform = process.platform) {
  return join(root, ".venvs", model, platform === "win32" ? "Scripts/python.exe" : "bin/python");
}
export function localEnvironment(environment = process.env, root?: string): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^(PYTHON|UV_|HF_|TRANSFORMERS_|PIP_|VIRTUAL_ENV|CONDA_|NODE_OPTIONS)/i.test(key)));
  return { ...clean, ...(root ? { HF_HOME:join(root,".hf-cache"), HF_MODULES_CACHE:join(root,".hf-cache","modules"), TORCH_HOME:join(root,".cache","torch") } : {}), PYTHONNOUSERSITE: "1", PYTHONUTF8: "1", CUDA_VISIBLE_DEVICES: "", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_IMPLICIT_TOKEN: "1" };
}
export interface LocalClient {
  status(model: LocalModel): LocalRuntimeStatus;
  install(model: LocalModel): Promise<void>;
  request(payload: MatchPayload, model: LocalModel, threads: number, signal?: AbortSignal): Promise<{
    output: ReturnType<typeof localOutput>["output"]; contextScore: number;
    inferenceMs: number; cpuMs: number; peakRssBytes: number; cold: boolean;
  }>;
  stop(): void;
}
const metrics = z.object({ inference_ms: z.number().finite().nonnegative(), cpu_ms: z.number().finite().nonnegative(), peak_rss_bytes: z.number().finite().nonnegative(), cold: z.boolean() });
export class LocalMatcher implements LocalClient {
  private child: ChildProcess | null = null;
  private setup: ChildProcess | null = null;
  private active = "";
  private state: LocalRuntimeStatus = { state: "not-installed", progress: "", error: null, startupMs: null };
  private startup: Promise<void> | null = null;
  private pending: { id: number; resolve: (row: any) => void; reject: (error: Error) => void } | null = null;
  private sequence = 0;
  private closeLog: () => void = () => {};
  constructor(private root: string, private changed: () => void, private assets =
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath && existsSync(join((process as any).resourcesPath, "local-matching"))
      ? join((process as any).resourcesPath, "local-matching") : resolve("out/local-matching"),
    private launch: typeof spawn = spawn) {}
  status(model: LocalModel): LocalRuntimeStatus {
    if (this.active.startsWith(model + ":")) return { ...this.state };
    return { state: this.installed(model) ? "installed" : "not-installed", progress: "", error: null, startupMs: null };
  }
  private installed(model: LocalModel) {
    return existsSync(localPython(this.root, model)) && existsSync(join(this.root, model) + ".provenance.json");
  }
  private update(patch: Partial<LocalRuntimeStatus>) { this.state = { ...this.state, ...patch }; this.changed(); }
  private kill(child: ChildProcess | null) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // Kill only our owned process tree: installer -> uv/hf/Python on Windows.
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
      killer.on("error", () => child.kill());
    } else child.kill("SIGKILL");
  }
  stop(): void {
    const worker = this.child, setup = this.setup;
    this.child = null; this.setup = null; this.active = "";
    this.kill(worker); this.kill(setup); this.closeLog(); this.closeLog = () => {};
    this.pending?.reject(new LocalMatchingError("cancelled","Local matching cancelled")); this.pending = null;
    this.startup = null;
  }
  async install(model: LocalModel): Promise<void> {
    if (this.setup) throw new Error("Model setup is already running");
    this.stop(); this.active = model + ":setup";
    this.update({ state: "installing", progress: "Preparing model setup", error: null, startupMs: null });
    const child = fork(join(this.assets, "setup.cjs"), [this.root, model, this.assets], {
      execPath: process.execPath, env: { ...localEnvironment(process.env,this.root), HF_HUB_OFFLINE: undefined, TRANSFORMERS_OFFLINE: undefined, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true, silent: true,
    });
    this.setup = child;
    child.stdout?.resume(); child.stderr?.resume();
    let complete = false;
    child.on("message", message => {
      if (this.setup !== child) return;
      const parsed = z.object({ stage: z.string().max(160).optional(), complete: z.boolean().optional() }).safeParse(message);
      if (parsed.success) { if (parsed.data.stage) this.update({ progress: parsed.data.stage }); complete ||= !!parsed.data.complete; }
    });
    const timer = setTimeout(() => this.kill(child), 45 * 60_000);
    try {
      await new Promise<void>((done, reject) => {
        child.once("error", () => reject(new Error("Could not start local setup")));
        child.once("close", code => code === 0 && complete && this.setup === child && this.installed(model) ? done() : reject(new Error(`Local setup failed. Check ${join(this.root, "setup.log")}, then retry.`)));
      });
      this.update({ state: "installed", progress: "Model installed; test it before enabling links" });
    } catch (error) {
      if (this.setup === child) this.update({ state: "error", error: (error as Error).message });
      throw error;
    } finally { clearTimeout(timer); if (this.setup === child) this.setup = null; }
  }
  private async start(model: LocalModel, threads: number): Promise<void> {
    const identity = `${model}:${threads}`;
    if (this.active === identity && this.state.state === "ready") return;
    if (this.active === identity && this.startup) return this.startup;
    if (!this.installed(model)) throw new LocalMatchingError("unavailable","Download the local model first");
    this.stop(); this.active = identity;
    this.update({ state: "loading", progress: "Loading CPU model", error: null, startupMs: null });
    const profile = LOCAL_MODELS[model];
    const child = this.launch(localPython(this.root, model), ["-u", join(this.assets, "desktop_worker.py"), join(this.root, model), profile.repo, profile.revision, String(threads)],
      { env: localEnvironment(process.env,this.root), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    // Keep useful diagnostics locally, including inference tracebacks, under one byte limit.
    // Synchronous descriptor so stop() releases the file immediately (Windows cannot delete open files).
    let fd: number | null = null;
    try { fd = openSync(join(this.root, "worker.log"), "w"); } catch { /* logging is best effort */ }
    let logged = 0;
    const log = { write: (text: string | Buffer) => {
      if (fd === null) return;
      const data = Buffer.from(text).subarray(0, Math.max(0, 4 * 1024 * 1024 - logged));
      try {
        let offset = 0;
        while (offset < data.length) {
          const written = writeSync(fd, data, offset, data.length - offset);
          if (!written) break;
          offset += written; logged += written;
        }
      } catch { /* logging is best effort */ }
    }, end: () => { if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } fd = null; } } };
    child.stderr?.on("data", (data: Buffer) => { log.write(data); });
    child.once("close", () => log.end());
    this.closeLog = log.end;
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    const loading = new Promise<void>((done, reject) => {
      const failed = () => {
        reject(new LocalMatchingError("worker",`Local CPU worker failed; see ${join(this.root, "worker.log")}, then test the model to retry`));
        if (this.child === child) {
          this.pending?.reject(new LocalMatchingError("worker","Local CPU worker failed")); this.pending = null;
          this.child = null; this.update({ state: "error", error: `Local CPU worker failed; see ${join(this.root, "worker.log")}, then test the model to retry` });
        }
      };
      child.once("error", failed); child.once("close", failed);
      child.stdout?.on("error", failed); child.stdin?.on("error", failed);
      child.stdout?.on("data", data => {
        if (this.child !== child) return;
        buffer += decoder.write(data);
        if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { this.kill(child); failed(); return; }
        for (;;) {
          const newline = buffer.indexOf("\n"); if (newline < 0) break;
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const row = JSON.parse(line);
            if (row.ready && this.state.state === "loading") {
              const value = z.object({ ready: z.literal(true), startup_ms: z.number().finite().nonnegative() }).parse(row);
              this.update({ state: "ready", progress: "CPU model ready", startupMs: value.startup_ms }); done();
            } else if (this.pending && row.id === this.pending.id) {
              const pending = this.pending; this.pending = null;
              if (row.error) {
                log.write(`[${new Date().toISOString()}] inference failed\n`);
                pending.reject(new LocalMatchingError(row.error === "input_too_large" ? "input" : "inference",`Local inference failed; see ${join(this.root, "worker.log")} for details`));
              } else pending.resolve(row);
            } else if (row.error) { this.kill(child); failed(); }
            else { throw new Error("Unexpected worker message"); }
          } catch { this.kill(child); failed(); }
        }
      });
    });
    const timer = setTimeout(() => this.kill(child), 180_000);
    this.startup = loading;
    try { await loading; }
    finally { clearTimeout(timer); if (this.startup === loading) this.startup = null; }
  }
  async request(payload: MatchPayload, model: LocalModel, threads: number, signal?: AbortSignal) {
    if (this.setup) throw new Error("Wait for local setup to finish");
    const abort = () => this.stop();
    if (signal?.aborted) throw new Error("Local matching cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      await this.start(model, threads);
      if (signal?.aborted) throw new Error("Local matching cancelled");
      if (this.pending) throw new Error("A local request is already running");
      const id = ++this.sequence, line = JSON.stringify({ id, request: localRequest(payload) }) + "\n";
      if (Buffer.byteLength(line) > 512 * 1024) throw new LocalMatchingError("input","Local matching input exceeds the protocol limit");
      const row = await new Promise<any>((done, reject) => {
        this.pending = { id, resolve: done, reject };
        timer = setTimeout(() => { reject(new LocalMatchingError("timeout","Local inference timed out")); this.stop(); }, 60_000);
        this.child!.stdin!.write(line, error => { if (error) { reject(new LocalMatchingError("worker","Local worker input failed")); this.stop(); } });
      });
      try {
        const resource = metrics.parse(row), parsed = localOutput(row.raw, payload, model);
        return { ...parsed, inferenceMs: resource.inference_ms, cpuMs: resource.cpu_ms, peakRssBytes: resource.peak_rss_bytes, cold: resource.cold };
      } catch { throw new LocalMatchingError("invalid-output","Invalid local model response"); }
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
}
