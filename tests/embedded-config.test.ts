import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { embeddedConfig, connectionDiagnostic } from "../src/main/embedded-config";

test("explicit provider/auth choices fail closed; diagnostics contain no raw configuration", () => {
  assert.match(embeddedConfig({ ACD_EMBEDDED_PROVIDER: "openrouter" }).diagnostic!, /ANTHROPIC_AUTH_TOKEN/);
  assert.match(embeddedConfig({ ACD_EMBEDDED_PROVIDER: "other" }).diagnostic!, /Unsupported/);
  assert.match(embeddedConfig({ ACD_EMBEDDED_AUTH: "unknown" }).diagnostic!, /Unsupported/);
  assert.match(embeddedConfig({ ANTHROPIC_BASE_URL: "https://secret.invalid/credential" }).diagnostic!, /endpoint/);
  assert.match(embeddedConfig({ ACD_EMBEDDED_MODEL: "secret?query" }).diagnostic!, /identifier/);
  const config = embeddedConfig({ ACD_EMBEDDED_PROVIDER: "openrouter", ANTHROPIC_AUTH_TOKEN: "synthetic", ACD_EMBEDDED_MODEL: "synthetic/main", ACD_EMBEDDED_HELPER_MODEL: "synthetic/helper" });
  assert.equal(config.diagnostic, undefined);
  assert.equal(config.env.ANTHROPIC_MODEL, "synthetic/main");
  assert.equal(config.env.CLAUDE_CODE_SUBAGENT_MODEL, "synthetic/helper");
});

test("Anthropic login and API modes preserve isolation from inherited providers and models", () => {
  const login = embeddedConfig({ ANTHROPIC_API_KEY: "unrelated", ANTHROPIC_AUTH_TOKEN: "unrelated", ANTHROPIC_MODEL: "unrelated", ANTHROPIC_DEFAULT_SONNET_MODEL: "unrelated" });
  assert.equal(login.authMode, "claude-code");
  assert.equal(login.diagnostic, undefined);
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"]) assert.equal(login.env[key], undefined);
  const api = embeddedConfig({ ACD_EMBEDDED_AUTH: "api-key", ANTHROPIC_API_KEY: "synthetic" });
  assert.equal(api.env.ANTHROPIC_API_KEY, "synthetic");
  assert.equal(api.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(api.diagnostic, undefined);
});

test("auth, billing, rate and model failures are actionable and never quote SDK strings", () => {
  for (const [error, expected] of [["401 synthetic-secret", /authentication/], ["402 synthetic-secret", /billing/], ["429 synthetic-secret", /rate limited/], ["404 synthetic-secret", /model unavailable/], ["unrecognized synthetic-secret", /connection failed/]] as const) {
    const result = connectionDiagnostic(new Error(error));
    assert.match(result, expected);
    assert.ok(!result.includes("synthetic-secret"));
  }
});

test("session identity excludes credential rotation but includes all model routing choices", () => {
  const source = { ACD_EMBEDDED_PROVIDER: "openrouter", ANTHROPIC_AUTH_TOKEN: "synthetic-one" };
  const config = embeddedConfig(source);
  assert.equal(config.identity, embeddedConfig({ ...source, ANTHROPIC_AUTH_TOKEN: "synthetic-two" }).identity);
  assert.notEqual(config.identity, embeddedConfig({ ...source, ACD_EMBEDDED_MODEL: "synthetic/main" }).identity);
  assert.notEqual(config.identity, embeddedConfig({ ...source, ACD_EMBEDDED_HELPER_MODEL: "synthetic/helper" }).identity);
});


test("live smoke cannot submit a query without its separate opt-in", () => {
  const result = spawnSync("node", ["scripts/smoke-embedded-sdk.mjs", "--inference"], { encoding: "utf8", env: { PATH: process.env.PATH, ACD_EMBEDDED_PROVIDER: "openrouter" }, timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires ACD_EMBEDDED_LIVE=1/);
  assert.ok(!result.stdout.includes("Inference result received"));
});

test("OpenRouter explicitly empties only the SDK API key whether parent key is omitted or nonempty", () => {
  for (const inheritedKey of [undefined, "synthetic-unrelated-parent-key"]) {
    const source: NodeJS.ProcessEnv = {
      ACD_EMBEDDED_PROVIDER: "openrouter",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "synthetic-runtime-token",
    };
    if (inheritedKey !== undefined) source.ANTHROPIC_API_KEY = inheritedKey;
    const original = { ...source };
    Object.freeze(source);
    const config = embeddedConfig(source);
    assert.equal(config.diagnostic, undefined);
    assert.ok(Object.hasOwn(config.env, "ANTHROPIC_API_KEY"));
    assert.equal(config.env.ANTHROPIC_API_KEY, "");
    assert.equal(config.env.ANTHROPIC_AUTH_TOKEN, "synthetic-runtime-token");
    assert.notEqual(config.env, source);
    assert.deepEqual(source, original);
    assert.equal(Object.hasOwn(source, "ANTHROPIC_API_KEY"), inheritedKey !== undefined);
  }
});
