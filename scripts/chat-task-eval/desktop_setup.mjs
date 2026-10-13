import { mkdir, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command, bootstrap, runtimeEnvironment } from "./runtime-tools.mjs";
import profiles from "../../src/shared/local-models.json" with { type: "json" };

async function main() {
  const [directory, model, assets] = process.argv.slice(2);
  if (!directory || !Object.hasOwn(profiles, model) || !assets) throw Error("Invalid setup arguments");
  if (process.platform === "darwin" && process.arch === "x64") throw Error("Intel macOS is not supported by this CPU runtime");
  if (!["win32", "linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch) || (process.platform === "win32" && process.arch !== "x64")) throw Error("Unsupported CPU platform");
  const root = resolve(directory), env = runtimeEnvironment(root), profile = profiles[model];
  await mkdir(root, { recursive: true });
  const progress = stage => process.send?.({ stage });
  progress("Installing managed Python runtime");
  const uv = await bootstrap(root, env, join(root, "setup.log"));
  const venv = join(root, ".venvs", model), python = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const options = { env, logPath: join(root, "setup.log"), timeout: 1800 };
  try { await access(python); } catch { await command(uv, ["venv", "--python", "3.13", "--managed-python", venv], options); }
  progress("Installing CPU dependencies");
  await command(uv, ["pip", "install", "--python", python, profile.requirements[0], ...(process.platform === "darwin" ? [] : ["--index-url", "https://download.pytorch.org/whl/cpu"])], options);
  await command(uv, ["pip", "install", "--python", python, ...profile.requirements], options);
  // Lets the model download trust the OS certificate store (corporate TLS-inspection proxies).
  await command(uv, ["pip", "install", "--python", python, "truststore==0.10.5"], options);
  progress("Downloading and verifying model (this can take several minutes)");
  const input = join(root, `${model}.setup.json`);
  await writeFile(input, JSON.stringify({ model_id: profile.repo, revision: profile.revision, model_path: join(root, model), exclude: profile.exclude }));
  await command(python, [join(assets, "bundle_download.py"), "--input", input], options);
  const environment = await command(uv, ["pip", "freeze", "--python", python], { env, timeout: 60 });
  await writeFile(join(root, `${model}.environment.txt`), environment + "\n");
  process.send?.({ stage: "Model installed", complete: true });
}
main().catch(() => { process.send?.({ failed: true }); process.exitCode = 1; }).finally(() => process.disconnect?.());
