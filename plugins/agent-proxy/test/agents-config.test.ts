import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyClaudeEnv,
  claudeApplied,
  renderCodexConfig,
  stripClaudeEnv,
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

test("stripClaudeEnv removes exactly the managed keys", () => {
  const content = applyClaudeEnv(JSON.stringify({ env: { KEEP: "yes" }, other: true }), TARGET);
  const { content: restored, changed } = stripClaudeEnv(content);
  assert.equal(changed, true);
  const parsed = JSON.parse(restored) as Record<string, unknown>;
  assert.deepEqual(parsed.env, { KEEP: "yes" });
  assert.equal(parsed.other, true);
});

test("stripClaudeEnv drops env entirely when it becomes empty", () => {
  const content = applyClaudeEnv(null, TARGET);
  const { content: restored, changed } = stripClaudeEnv(content);
  assert.equal(changed, true);
  assert.deepEqual(JSON.parse(restored), {});
});

test("stripClaudeEnv is a no-op when keys are absent", () => {
  const { changed } = stripClaudeEnv(JSON.stringify({ env: { A: "1" } }));
  assert.equal(changed, false);
});

test("claudeApplied detects the managed base url", () => {
  const content = applyClaudeEnv(null, TARGET);
  assert.equal(claudeApplied(content, TARGET.baseUrl), true);
  assert.equal(claudeApplied(content, "http://127.0.0.1:9999"), false);
  assert.equal(claudeApplied(null, TARGET.baseUrl), false);
  assert.equal(claudeApplied("garbage {", TARGET.baseUrl), false);
});

test("renderCodexConfig declares the proxy provider", () => {
  const toml = renderCodexConfig("http://127.0.0.1:8317/v1");
  assert.match(toml, /model_provider = "agent-proxy"/);
  assert.match(toml, /\[model_providers\.agent-proxy]/);
  assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:8317\/v1"/);
  assert.match(toml, /wire_api = "responses"/);
  assert.match(toml, new RegExp(`env_key = "${CODEX_ENV_KEY}"`));
});
