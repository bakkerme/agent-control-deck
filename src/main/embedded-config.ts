// Backend only: never send this object over IPC or persist it.
import { createHash } from "node:crypto";
export const DEEPSEEK_FLASH_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export type EmbeddedConfig = ReturnType<typeof embeddedConfig>;
export function embeddedConfig(source: NodeJS.ProcessEnv = process.env) {
  const provider = source.ACD_EMBEDDED_PROVIDER ?? "anthropic";
  const authMode = provider === "openrouter" ? "openrouter" : source.ACD_EMBEDDED_AUTH ?? "claude-code";
  const baseUrl = source.ANTHROPIC_BASE_URL ?? (provider === "openrouter" ? "https://openrouter.ai/api" : "https://api.anthropic.com");
  const model = source.ACD_EMBEDDED_MODEL ?? (provider === "openrouter" ? DEEPSEEK_FLASH_MODEL : undefined);
  const helperModel = source.ACD_EMBEDDED_HELPER_MODEL ?? model;
  let diagnostic: string | undefined;
  if (!["anthropic", "openrouter"].includes(provider) || !["claude-code", "api-key", "openrouter"].includes(authMode) || (provider === "anthropic" && authMode === "openrouter")) diagnostic = "Unsupported embedded provider/authentication configuration.";
  // Endpoints are deliberately bounded; arbitrary URLs could hide secrets or reroute credentials.
  if (baseUrl !== (provider === "openrouter" ? "https://openrouter.ai/api" : "https://api.anthropic.com")) diagnostic = "ANTHROPIC_BASE_URL must match the selected provider endpoint.";
  if ([model, helperModel].some(value => value !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value))) diagnostic = "Invalid embedded model identifier.";
  if (provider === "openrouter" && (!model || !helperModel)) diagnostic = "OpenRouter requires explicit main and helper models.";
  if (provider === "openrouter" && !source.ANTHROPIC_AUTH_TOKEN) diagnostic = "OpenRouter requires runtime ANTHROPIC_AUTH_TOKEN in the desktop backend environment; restart after injection.";
  if (authMode === "api-key" && !source.ANTHROPIC_API_KEY) diagnostic = "API-key mode requires ANTHROPIC_API_KEY in the desktop backend environment, then restart.";
  const env: Record<string, string | undefined> = {};
  // Preserve the cloud HTTPS proxy and CA trust for Network secret substitution.
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "LANG", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) env[key] = source[key];
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "agent-control-deck/embedded-experiment";
  if (provider === "openrouter") Object.assign(env, { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: source.ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY: "" });
  else if (authMode === "api-key") env.ANTHROPIC_API_KEY = source.ANTHROPIC_API_KEY;
  if (model) env.ANTHROPIC_MODEL = model;
  if (helperModel) for (const key of ["ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) env[key] = helperModel;
  // Includes helper selection: changing any model/endpoint/auth mode requires a fresh chat.
  const identity = createHash("sha256").update(JSON.stringify([provider, authMode, baseUrl, model ?? null, helperModel ?? null])).digest("hex");
  return { provider: provider as "anthropic" | "openrouter", authMode: authMode as "claude-code" | "api-key" | "openrouter", model, helperModel, identity, diagnostic, env };
}
export function connectionDiagnostic(error: unknown): string {
  // Classify only; never return raw SDK errors, URLs, headers or subprocess stderr.
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/\b(401|403)\b|authentication|unauthorized|invalid.?api.?key/i.test(text)) return "Agent authentication rejected. Check the selected provider and runtime credential injection, then restart.";
  if (/\b402\b|insufficient.*(credit|balance)|payment.required|billing.error/i.test(text)) return "Agent billing rejected. Check provider credits and spending limits.";
  if (/\b429\b|rate.limit/i.test(text)) return "Agent rate limited. Check provider limits before retrying.";
  if (/model.*(not.found|unsupported|unavailable)|\b404\b/i.test(text)) return "Agent model unavailable. Check the configured model and provider compatibility.";
  return "Agent connection failed. Check provider authentication, network/proxy, model compatibility and working directory before retrying.";
}
