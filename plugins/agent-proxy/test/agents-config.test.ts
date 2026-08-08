import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyClaudeEnv,
  captureClaudeEnvState,
  claudeApplied,
  renderCodexConfig,
  restoreClaudeEnv,
  CODEX_ENV_KEY,
} from "../lib/agents-config.ts";

const TARGET = { baseUrl: "http://127.0.0.1:8317", token: "local-key" };

test("applyClaudeEnv merges into an existing settings file", () => {
  const before = JSON.stringify({
    model: "opus",
    env: { EXISTING: "1" },
    permissions: { allow: ["Bash(ls:*)"] },
  });
  const after = JSON.parse(applyClaudeEnv(before, TARGET)) as Record<string, unknown>;
  assert.equal((after.env as Record<string, unknown>).EXISTING, "1");
  assert.equal((after.env as Record<string, unknown>).ANTHROPIC_BASE_URL, TARGET.baseUrl);
  assert.equal((after.env as Record<string, unknown>).ANTHROPIC_AUTH_TOKEN, TARGET.token);
  assert.equal(after.model, "opus");
  assert.deepEqual(after.permissions, { allow: ["Bash(ls:*)"] });
});

test("applyClaudeEnv creates a file from nothing", () => {
  const after = JSON.parse(applyClaudeEnv(null, TARGET)) as Record<string, unknown>;
  assert.deepEqual(after, {
    env: { ANTHROPIC_BASE_URL: TARGET.baseUrl, ANTHROPIC_AUTH_TOKEN: TARGET.token },
  });
});

test("applyClaudeEnv refuses non-object json", () => {
  assert.throws(() => applyClaudeEnv("[]", TARGET), /not a JSON object/);
  assert.throws(() => applyClaudeEnv("not json {", TARGET), /not valid JSON/);
});

test("restoreClaudeEnv reinstates pre-existing values", () => {
  const before = JSON.stringify({
    env: {
      KEEP: "yes",
      ANTHROPIC_BASE_URL: "https://previous.example",
      ANTHROPIC_AUTH_TOKEN: "previous-token",
    },
    other: true,
  });
  const state = captureClaudeEnvState(before, TARGET);
  const applied = applyClaudeEnv(before, TARGET);
  const restored = restoreClaudeEnv(applied, state);
  assert.equal(restored.changed, true);
  assert.equal(restored.preservedUserChanges, false);
  assert.deepEqual(JSON.parse(restored.content), JSON.parse(before));
});

test("restoreClaudeEnv removes keys that did not previously exist", () => {
  const state = captureClaudeEnvState(null, TARGET);
  const restored = restoreClaudeEnv(applyClaudeEnv(null, TARGET), state);
  assert.equal(restored.changed, true);
  assert.deepEqual(JSON.parse(restored.content), {});
});

test("restoreClaudeEnv preserves values changed after Apply", () => {
  const before = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://previous.example" } });
  const state = captureClaudeEnvState(before, TARGET);
  const changedByUser = JSON.parse(applyClaudeEnv(before, TARGET)) as Record<string, unknown>;
  (changedByUser.env as Record<string, unknown>).ANTHROPIC_AUTH_TOKEN = "user-rotated-token";
  const restored = restoreClaudeEnv(JSON.stringify(changedByUser), state);
  assert.equal(restored.changed, true);
  assert.equal(restored.preservedUserChanges, true);
  assert.deepEqual(JSON.parse(restored.content), {
    env: {
      ANTHROPIC_BASE_URL: "https://previous.example",
      ANTHROPIC_AUTH_TOKEN: "user-rotated-token",
    },
  });
});

test("captureClaudeEnvState retains the original baseline across target changes", () => {
  const before = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "original" } });
  const first = captureClaudeEnvState(before, TARGET);
  const nextTarget = { baseUrl: "http://127.0.0.1:9000", token: "local-key" };
  const second = captureClaudeEnvState(applyClaudeEnv(before, TARGET), nextTarget, first);
  const restored = restoreClaudeEnv(applyClaudeEnv(before, nextTarget), second);
  assert.deepEqual(JSON.parse(restored.content), JSON.parse(before));
});

test("claudeApplied requires both the managed base URL and token", () => {
  const content = applyClaudeEnv(null, TARGET);
  assert.equal(claudeApplied(content, TARGET), true);
  assert.equal(claudeApplied(content, { ...TARGET, baseUrl: "http://127.0.0.1:9999" }), false);
  assert.equal(claudeApplied(content, { ...TARGET, token: "stale" }), false);
  assert.equal(claudeApplied(null, TARGET), false);
  assert.equal(claudeApplied("garbage {", TARGET), false);
});

test("renderCodexConfig declares the proxy provider", () => {
  const toml = renderCodexConfig("http://127.0.0.1:8317/v1");
  assert.match(toml, /model_provider = "agent-proxy"/);
  assert.match(toml, /\[model_providers\.agent-proxy]/);
  assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:8317\/v1"/);
  assert.match(toml, /wire_api = "responses"/);
  assert.match(toml, new RegExp(`env_key = "${CODEX_ENV_KEY}"`));
});
