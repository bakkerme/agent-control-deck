import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { UV_VERSION, UV_INSTALLER_HASHES } from "./benchmark-core.mjs";
const hash = data => createHash("sha256").update(data).digest("hex");
// No shell interpolation: paths containing spaces work on all supported platforms.
export async function command(executable, args, { env, logPath, timeout = 0, echo = false } = {}) {
  const log = logPath ? createWriteStream(logPath, { flags: "a" }) : null;
  let captured = "", timedOut = false, forceTimer;
  const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
  log?.on("error", () => child.kill());
  child.stdout.on("data", data => { if (captured.length < 4 * 1024 * 1024) captured += data.toString(); log?.write(data); if (echo) process.stdout.write(data); });
  child.stderr.on("data", data => { log?.write(data); if (echo) process.stderr.write(data); });
  const timer = timeout ? setTimeout(() => { timedOut = true; child.kill(); forceTimer = setTimeout(() => child.kill("SIGKILL"), 2000); }, timeout * 1000) : null;
  const failure = await new Promise(done => {
    child.once("error", error => done(`Could not launch ${executable}: ${error.message}`));
    child.once("close", (code, signal) => done(timedOut ? `Exceeded ${timeout}s timeout` : code === 0 ? null : `${executable} exited ${code ?? signal}`));
  });
  clearTimeout(timer); clearTimeout(forceTimer);
  if (log) await new Promise(done => log.end(done));
  if (failure) throw new Error(`${failure}${logPath ? `; see ${logPath}` : ""}`);
  return captured.trim();
}

export function installerCommand(path, platform = process.platform) {
  return platform === "win32" ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path]] : ["sh", [path]];
}

export function runtimeEnvironment(workDir, environment = process.env) {
  // Use task-local caches; do not inherit credentials or Python path overrides.
  const env = Object.fromEntries(Object.entries(environment).filter(([k]) =>
    !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k) && !/^(PYTHON|UV_|HF_|TRANSFORMERS_|PIP_|VIRTUAL_ENV|CONDA_|NODE_OPTIONS)/i.test(k)));
  return { ...env, UV_UNMANAGED_INSTALL: join(workDir, ".tools", "uv"), UV_NO_MODIFY_PATH: "1", UV_NO_CONFIG: "1",
    UV_PYTHON_INSTALL_DIR: join(workDir, ".python"), UV_PYTHON_BIN_DIR: join(workDir, ".tools", "python"),
    UV_CACHE_DIR: join(workDir, ".cache", "uv"), HF_HOME: join(workDir, ".hf-cache"), HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_DISABLE_IMPLICIT_TOKEN: "1", PYTHONNOUSERSITE: "1", PYTHONUTF8: "1", CUDA_VISIBLE_DEVICES: "" };
}

export async function bootstrap(workDir, env, logPath, exec = command) {
  const localUv = join(env.UV_UNMANAGED_INSTALL, process.platform === "win32" ? "uv.exe" : "uv");
  for (const candidate of [localUv, "uv"]) {
    try { if ((await exec(candidate, ["--version"], { env })).startsWith(`uv ${UV_VERSION} `)) return candidate; } catch { /* Bootstrap a pinned copy. */ }
  }
  const suffix = process.platform === "win32" ? "ps1" : "sh";
  const url = `https://astral.sh/uv/${UV_VERSION}/install.${suffix}`;
  console.log(`Installing task-local uv ${UV_VERSION} from ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Installer download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== UV_INSTALLER_HASHES[suffix]) throw new Error("Pinned uv installer SHA-256 mismatch");
  const path = join(workDir, ".tools", `install.${suffix}`);
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
  const [executable, args] = installerCommand(path);
  await exec(executable, args, { env, logPath, timeout: 600, echo: true });
  const version = await exec(localUv, ["--version"], { env });
  if (!version.startsWith(`uv ${UV_VERSION} `)) throw new Error(`Unexpected uv version: ${version}`);
  return localUv;
}
