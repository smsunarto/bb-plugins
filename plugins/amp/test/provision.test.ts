import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupLegacyAmpEntry,
  inspectLegacyAmpEntry,
  legacyEntryDeviations,
  resolveAmpCliLaunch,
  resolveNodeRuntime,
} from "../lib/provision.ts";

function fakeExecutable(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amp-plugin-"));
  const bin = join(root, "bin");
  const amp = fakeExecutable(bin, "amp");
  const logoPath = join(root, "logos", "amp.svg");
  mkdirSync(join(root, "logos"), { recursive: true });
  writeFileSync(logoPath, "<svg/>");
  return {
    root,
    bin,
    amp,
    paths: { configPath: join(root, "config.json"), logoPath },
  };
}

function writeConfig(configPath: string, config: unknown): void {
  writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
}

/** A legacy entry as the retired provisioning wrote it on a plain-node host. */
function managedEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "amp",
    displayName: "Amp",
    command: "/usr/local/bin/node",
    args: ["/old/plugin-cache/abc123/dist/bridge.js"],
    env: { AMP_CLI_PATH: "/usr/local/bin/amp" },
    logo: "logos/amp.svg",
    nativeSkillRoots: {
      user: [".config/agents/skills", ".agents/skills", ".config/amp/skills", ".claude/skills"],
      project: [".agents/skills", ".claude/skills"],
    },
    ...overrides,
  };
}

test("resolveNodeRuntime flags anything but plain node as Electron", () => {
  assert.deepEqual(resolveNodeRuntime("/usr/local/bin/node", "darwin"), {
    node: "/usr/local/bin/node",
    electron: false,
  });
  assert.deepEqual(resolveNodeRuntime("/Applications/bb.app/Contents/MacOS/bb", "darwin"), {
    node: "/Applications/bb.app/Contents/MacOS/bb",
    electron: true,
  });
  assert.equal(resolveNodeRuntime("C:\\nodejs\\Node.exe", "win32").electron, false);
});

test("resolveAmpCliLaunch uses the registration-resolved path", () => {
  const f = fixture();
  const launch = resolveAmpCliLaunch(f.amp, { PATH: "/nonexistent" });
  assert.notEqual(launch, null);
  assert.equal(launch?.command, f.amp);
  assert.equal(launch?.env.AMP_CLI_PATH, f.amp);
});

test("resolveAmpCliLaunch falls back to a fresh lookup for a stale path", () => {
  const f = fixture();
  const launch = resolveAmpCliLaunch(join(f.root, "gone", "amp"), { PATH: f.bin });
  assert.equal(launch?.command, f.amp);
  assert.equal(launch?.env.AMP_CLI_PATH, f.amp);
});

test("cleanup removes a plain-node managed entry and keeps everything else", () => {
  const f = fixture();
  writeConfig(f.paths.configPath, {
    theme: "dark",
    customAcpAgents: [{ id: "other", command: "/bin/other" }, managedEntry()],
  });

  assert.deepEqual(inspectLegacyAmpEntry(f.paths.configPath), { entry: "managed" });
  assert.deepEqual(cleanupLegacyAmpEntry(f.paths), { kind: "removed" });

  const config = JSON.parse(readFileSync(f.paths.configPath, "utf8"));
  assert.equal(config.theme, "dark");
  assert.deepEqual(config.customAcpAgents, [{ id: "other", command: "/bin/other" }]);
  assert.equal(existsSync(f.paths.logoPath), false);
  assert.deepEqual(inspectLegacyAmpEntry(f.paths.configPath), { entry: "absent" });
});

test("cleanup removes an Electron-hosted managed entry at a stale bridge path", () => {
  const f = fixture();
  writeConfig(f.paths.configPath, {
    customAcpAgents: [
      managedEntry({
        command: "/Applications/bb.app/Contents/MacOS/bb",
        args: ["/old/worktree/plugins/amp/dist/bridge.js"],
        env: { AMP_CLI_PATH: "/opt/homebrew/bin/amp", ELECTRON_RUN_AS_NODE: "1" },
      }),
    ],
  });
  assert.deepEqual(cleanupLegacyAmpEntry(f.paths), { kind: "removed" });
  assert.deepEqual(JSON.parse(readFileSync(f.paths.configPath, "utf8")).customAcpAgents, []);
});

test("cleanup removes a minimal managed entry without optional fields", () => {
  const f = fixture();
  writeConfig(f.paths.configPath, {
    customAcpAgents: [
      {
        id: "amp",
        command: "/usr/local/bin/node",
        args: ["/old/install/dist/bridge.js"],
        env: { AMP_CLI_PATH: "/usr/local/bin/amp" },
      },
    ],
  });
  assert.deepEqual(cleanupLegacyAmpEntry(f.paths), { kind: "removed" });
});

test("cleanup is idempotent", () => {
  const f = fixture();
  writeConfig(f.paths.configPath, { customAcpAgents: [managedEntry()] });
  assert.deepEqual(cleanupLegacyAmpEntry(f.paths), { kind: "removed" });
  const afterFirst = readFileSync(f.paths.configPath, "utf8");
  assert.deepEqual(cleanupLegacyAmpEntry(f.paths), { kind: "clean" });
  assert.equal(readFileSync(f.paths.configPath, "utf8"), afterFirst);
});

test("cleanup leaves an entry with an added env var and names it", () => {
  const f = fixture();
  writeConfig(f.paths.configPath, {
    customAcpAgents: [
      managedEntry({
        env: { AMP_CLI_PATH: "/usr/local/bin/amp", RAINDROP_LOCAL_DEBUGGER: "1" },
      }),
    ],
  });
  const before = readFileSync(f.paths.configPath, "utf8");

  assert.deepEqual(cleanupLegacyAmpEntry(f.paths), {
    kind: "kept",
    deviations: ["env.RAINDROP_LOCAL_DEBUGGER"],
  });
  assert.equal(readFileSync(f.paths.configPath, "utf8"), before);
  assert.equal(existsSync(f.paths.logoPath), true);
  assert.deepEqual(inspectLegacyAmpEntry(f.paths.configPath), {
    entry: "customized",
    deviations: ["env.RAINDROP_LOCAL_DEBUGGER"],
  });
});

test("cleanup leaves an entry with customized fields the plugin never wrote", () => {
  const f = fixture();
  writeConfig(f.paths.configPath, {
    customAcpAgents: [managedEntry({ supportsManualCompaction: true, logo: "logos/custom.svg" })],
  });
  const result = cleanupLegacyAmpEntry(f.paths);
  assert.equal(result.kind, "kept");
  assert.deepEqual(
    result.kind === "kept" ? result.deviations.toSorted() : [],
    ["logo", "supportsManualCompaction"],
  );
});

test("deviation shape checks: args, env, displayName, skill roots", () => {
  assert.deepEqual(legacyEntryDeviations(managedEntry()), []);
  assert.deepEqual(legacyEntryDeviations(managedEntry({ args: ["/somewhere/else.js"] })), ["args"]);
  assert.deepEqual(legacyEntryDeviations(managedEntry({ args: ["/a/bridge.js", "--flag"] })), [
    "args",
  ]);
  assert.deepEqual(legacyEntryDeviations(managedEntry({ displayName: "My Amp" })), ["displayName"]);
  assert.deepEqual(
    legacyEntryDeviations(managedEntry({ nativeSkillRoots: { user: [".mine"], project: [] } })),
    ["nativeSkillRoots"],
  );
});

test("cleanup with no config file reports clean", () => {
  const f = fixture();
  assert.deepEqual(cleanupLegacyAmpEntry(f.paths), { kind: "clean" });
  assert.equal(existsSync(f.paths.configPath), false);
});
