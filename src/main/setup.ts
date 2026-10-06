import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Setup, Source } from "../shared/types";

export const DEFAULT_HTTP_PORT = 43821;
export interface HookConnection { url: string }
export const hookEvents = (provider: Source["provider"]): string[] =>
  provider === "claude"
    ? ["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd", "Notification", "PostToolUse", "PostToolUseFailure", "ElicitationResult"]
    : provider === "codex"
      ? ["UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"]
      : ["beforeSubmitPrompt", "afterAgentResponse", "stop", "sessionEnd"];

// HTTP origins also remain safe literal arguments in the provider hook shells.
export function hookOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || !/^[a-zA-Z0-9.\-:\[\]]+$/.test(url.hostname))
    throw new Error("Hook receiver URL must be an http:// host and optional port, without credentials or a path");
  return url.origin;
}
export function sourceToken(root: string, id: string): string {
  const directory = join(root, "hooks", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "http-token");
  try {
    writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  const token = readFileSync(path, "utf8");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid source credential; restore its http-token file from backup");
  return token;
}
export function sourceSetup(
  root: string, source: Source, platform = process.platform,
  connection: HookConnection = { url: `http://127.0.0.1:${DEFAULT_HTTP_PORT}` },
): Setup {
  const windowsWSL = platform === "win32" && source.environment === "wsl";
  const directHTTP = source.provider === "claude" && !windowsWSL;
  // curl.exe launched by WSL runs on Windows. Its request uses the Windows
  // receiver address, never the WSL VM's host-IP/networking route.
  const origin = hookOrigin(connection.url);
  const endpoint = `${origin}/hooks/${source.id}`;
  const token = sourceToken(root, source.id);
  const headers = { Authorization: `Bearer ${token}` };
  const curl = windowsWSL ? '"/mnt/c/Windows/System32/curl.exe"' : platform === "win32" ? "curl.exe" : "curl";
  const request = (event: string) => `${curl} --silent --fail --noproxy "*" --connect-timeout 1 --max-time 2 -H "Content-Type: application/json" -H "Authorization: Bearer ${token}" --data-binary "@-" "${endpoint}/${event}"`;
  const command = (event: string) => {
    const response = source.provider === "cursor" && event === "beforeSubmitPrompt"
      ? '{"continue":true}' : source.provider === "codex" && event === "Stop" ? "{}" : "";
    // Hooks observe only. Ignore transport output and finish successfully even
    // when the deck is closed, curl is missing, or delivery is refused. Keep
    // the separate diagnostic command strict so setup failures stay testable.
    const cmd = platform === "win32" && !windowsWSL;
    return cmd
      ? `${request(event)} >NUL 2>&1 & ${response ? `echo ${response}` : "exit /b 0"}`
      : `${request(event)} >/dev/null 2>&1; ${response ? `printf '%s\\n' '${response}'` : "true"}`;
  };
  const hooks = Object.fromEntries(hookEvents(source.provider).map((event) => {
    const hook = directHTTP
      ? { type: "http", url: `${endpoint}/${event}`, headers, timeout: 3 }
      : { ...(source.provider !== "cursor" ? { type: "command" } : {}), command: command(event), timeout: 3 };
    return [event, source.provider === "cursor" ? [hook] : [{ hooks: [hook] }]];
  }));
  return {
    inbox: join(root, "inbox", source.id), endpoint,
    testCommand: request(source.provider === "cursor" ? "beforeSubmitPrompt" : "UserPromptSubmit"),
    config: JSON.stringify({ ...(source.provider === "cursor" ? { version: 1 } : {}), hooks }, null, 2),
    configFile: source.provider === "codex"
      ? "$CODEX_HOME/hooks.json (default: ~/.codex/hooks.json)"
      : source.provider === "claude" ? "~/.claude/settings.json" : "~/.cursor/hooks.json",
    instructions: (source.provider === "codex"
      ? "Codex: review and trust these hooks in Codex before they can run (CLI: /hooks). " : "") +
      (windowsWSL
        ? "WSL hooks invoke /mnt/c/Windows/System32/curl.exe directly, which sends HTTP from Windows to the deck without requiring Windows directories on your WSL PATH. No PowerShell or collector script is needed. Windows executable interoperability must be enabled. If your Windows drive or WSL mount root differs, adjust the executable path in the hook commands. "
        : directHTTP ? "Claude sends HTTP events directly; no collector script is needed. "
        : "Command hooks forward events with curl; no collector script, Node, or Python is needed. ") +
      (source.environment === "wsl"
        ? "Configure hooks inside your WSL distro, with a separate source per distro. Use the Windows deck to generate the real WSL configuration. With the receiver on Windows loopback, no WSL host-IP, mirrored-networking setup, or inbound firewall exception is needed for this route. " : "") +
      "Keep the deck running. A chat appears on its next submitted prompt, including an existing resumed chat. Command hooks finish quietly and successfully if the deck is unavailable; the diagnostic command still reports delivery failures. Events emitted while the deck is closed are not captured. Replace the deck's old hook entries and preserve unrelated hooks.",
  };
}
export function writeHookSetup(root: string, source: Source, connection?: HookConnection): Setup {
  const setup = sourceSetup(root, source, process.platform, connection);
  mkdirSync(setup.inbox, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "hooks", source.id, "config-fragment.json"), setup.config, { mode: 0o600 });
  return setup;
}
