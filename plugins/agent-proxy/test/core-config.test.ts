import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readConfigPort,
  reconcileConfigFile,
  renderInitialConfig,
  setConfigManagementKey,
  setConfigPort,
} from "../lib/core-config.ts";
import { timestampedBackup, writeAtomic } from "../lib/fsx.ts";

const OPTS = {
  port: 8317,
  managementKey: "mgmt-key-plaintext",
  localApiKey: "local-key",
  authDir: "/data/plugins/agent-proxy/core/auth",
};

test("renderInitialConfig produces the expected yaml", () => {
  const text = renderInitialConfig(OPTS);
  assert.match(text, /host: "?127\.0\.0\.1"?/);
  assert.match(text, /port: 8317/);
  assert.match(text, /allow-remote: false/);
  assert.match(text, /secret-key: mgmt-key-plaintext/);
  assert.match(text, /auth-dir: \/data\/plugins\/agent-proxy\/core\/auth/);
  assert.match(text, /api-keys:\n\s+- local-key/);
  assert.match(text, /usage-statistics-enabled: true/);
  assert.match(text, /Managed by bb-plugin-agent-proxy/);
});

test("surgical updates preserve core-owned edits", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-config-"));
  const path = join(dir, "config.yaml");
  // Simulate a file the core has already rewritten: hashed secret-key plus
  // provider blocks added through the management API.
  writeFileSync(
    path,
    [
      "# core comment",
      "host: 127.0.0.1",
      "port: 8317",
      "remote-management:",
      "  allow-remote: false",
      '  secret-key: "$2a$10$bcrypthashbcrypthashbcrypthash"',
      "auth-dir: /somewhere/auth",
      "api-keys:",
      "  - local-key",
      "claude-api-key:",
      "  - api-key: sk-ant-upstream",
      "    base-url: https://api.anthropic.com",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o644);

  setConfigPort(path, 9000);
  let text = readFileSync(path, "utf8");
  assert.match(text, /port: 9000/);
  assert.match(text, /\$2a\$10\$bcrypthash/); // untouched hash
  assert.match(text, /sk-ant-upstream/); // untouched provider block
  assert.match(text, /# core comment/);

  setConfigManagementKey(path, "fresh-plaintext");
  text = readFileSync(path, "utf8");
  assert.match(text, /secret-key: "?fresh-plaintext"?/);
  assert.match(text, /port: 9000/);
  assert.match(text, /sk-ant-upstream/);
  assert.equal(statSync(path).mode & 0o777, 0o600);

  assert.equal(readConfigPort(path), 9000);
});

test("reconcileConfigFile restores plugin invariants without deleting user keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-config-"));
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    [
      "host: 0.0.0.0",
      "port: 9999",
      "remote-management:",
      "  allow-remote: true",
      "  secret-key: stale",
      "auth-dir: /stale",
      "api-keys:",
      "  - extra-user-key",
      "openai-compatibility:",
      "  - name: custom",
      "",
    ].join("\n"),
  );

  reconcileConfigFile(path, OPTS);
  const text = readFileSync(path, "utf8");
  assert.match(text, /host: "?127\.0\.0\.1"?/);
  assert.match(text, /port: 8317/);
  assert.match(text, /allow-remote: false/);
  assert.match(text, /secret-key: mgmt-key-plaintext/);
  assert.match(text, /auth-dir: \/data\/plugins\/agent-proxy\/core\/auth/);
  assert.match(text, /- local-key/);
  assert.match(text, /- extra-user-key/);
  assert.match(text, /name: custom/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("updateConfigFile refuses missing or invalid files", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-config-"));
  const missing = join(dir, "nope.yaml");
  assert.throws(() => setConfigPort(missing, 1), /missing/);
  const bad = join(dir, "bad.yaml");
  writeFileSync(bad, "a: [unclosed");
  assert.throws(() => setConfigPort(bad, 1), /not valid YAML/);
});

test("readConfigPort returns null when unreadable", () => {
  assert.equal(readConfigPort("/definitely/not/here.yaml"), null);
});

test("credential writes and backups are private", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-private-"));
  const configPath = join(dir, "config.yaml");
  writeAtomic(configPath, "secret: value\n", 0o600);
  const backupPath = timestampedBackup("token=value\n", join(dir, "backups"), "settings.json");
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
});
