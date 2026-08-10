import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_ID,
  inspectInstallation,
  managedAgentEntry,
  provisionInstallation,
  resolveAmpCli,
  resolveNodeRuntime,
} from "../lib/provision.ts";

function fakeExecutable(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

function fakeBundle(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "bridge.js");
  writeFileSync(path, "// bundled bridge\n");
  return path;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amp-plugin-"));
  const bin = join(root, "bin");
  const node = fakeExecutable(bin, "node");
  const amp = fakeExecutable(bin, "amp");
  const bridge = fakeBundle(join(root, "dist"));
  return {
    root,
    bin,
    node,
    amp,
    bridge,
    launch: { node, electron: false, bridge, amp },
    paths: {
      dataDir: root,
      configPath: join(root, "config.json"),
      logoPath: join(root, "logos", "amp.svg"),
    },
  };
}

test("resolves the Amp CLI from PATH", () => {
  const { root, bin, amp } = fixture();
  assert.equal(resolveAmpCli({ PATH: bin }, root, "linux"), amp);
});

test("resolves the Amp CLI from known candidate dirs off PATH", () => {
  const home = mkdtempSync(join(tmpdir(), "amp-home-"));
  const amp = fakeExecutable(join(home, ".amp", "bin"), "amp");
  assert.equal(resolveAmpCli({ PATH: "" }, home, "linux"), amp);
});

test("reports a missing Amp CLI as null", () => {
  const home = mkdtempSync(join(tmpdir(), "amp-empty-"));
  assert.equal(resolveAmpCli({ PATH: "" }, home, "linux"), null);
});

test("managed entry runs node with the bridge bundle and AMP_CLI_PATH, no nativeReasoning", () => {
  const entry = managedAgentEntry({
    node: "/usr/bin/node",
    electron: false,
    bridge: "/plugin/dist/bridge.js",
    amp: "/tmp/amp",
  });
  assert.equal(entry.command, "/usr/bin/node");
  assert.deepEqual(entry.args, ["/plugin/dist/bridge.js"]);
  assert.deepEqual(entry.env, { AMP_CLI_PATH: "/tmp/amp" });
  assert.equal(entry.logo, "logos/amp.svg");
  assert.equal("nativeReasoning" in entry, false);
  assert.equal("modelCli" in entry, false);
  assert.equal("cwd" in entry, false);
});

test("an Electron host is detected and the entry gets ELECTRON_RUN_AS_NODE=1", () => {
  // bb's own binary: Electron only runs a script as node with this flag set;
  // without it the spawn launches the GUI and bb sees a silent ACP agent.
  const runtime = resolveNodeRuntime("/Applications/bb.app/Contents/MacOS/bb", "darwin");
  assert.equal(runtime.electron, true);
  assert.equal(runtime.node, "/Applications/bb.app/Contents/MacOS/bb");
  const entry = managedAgentEntry({ ...runtime, bridge: "/plugin/dist/bridge.js", amp: "/tmp/amp" });
  assert.deepEqual(entry.env, { AMP_CLI_PATH: "/tmp/amp", ELECTRON_RUN_AS_NODE: "1" });
});

test("a plain node host is not flagged as Electron", () => {
  assert.deepEqual(resolveNodeRuntime("/opt/homebrew/bin/node", "darwin"), {
    node: "/opt/homebrew/bin/node",
    electron: false,
  });
  assert.equal(resolveNodeRuntime("C:\\Program Files\\nodejs\\node.exe", "win32").electron, false);
});

test("provisioning under Electron writes the run-as-node flag and drops it again on plain node", () => {
  const { launch, paths } = fixture();
  provisionInstallation(paths, { ...launch, electron: true });
  const underElectron = JSON.parse(readFileSync(paths.configPath, "utf8"));
  assert.equal(underElectron.customAcpAgents[0].env.ELECTRON_RUN_AS_NODE, "1");

  provisionInstallation(paths, { ...launch, electron: false });
  const underNode = JSON.parse(readFileSync(paths.configPath, "utf8"));
  assert.equal("ELECTRON_RUN_AS_NODE" in underNode.customAcpAgents[0].env, false);
  assert.equal(underNode.customAcpAgents[0].env.AMP_CLI_PATH, launch.amp);
});

test("fresh install adds entry without clobbering other config and is idempotent", () => {
  const { launch, paths } = fixture();
  writeFileSync(paths.configPath, JSON.stringify({
    config: { BB_LOG_LEVEL: "debug" },
    customAcpAgents: [{ id: "other", displayName: "Other", command: "other" }],
  }));
  const first = provisionInstallation(paths, launch);
  assert.equal(first.changed, true);
  const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
  assert.equal(config.config.BB_LOG_LEVEL, "debug");
  assert.equal(config.customAcpAgents.length, 2);
  assert.equal(config.customAcpAgents[1].id, AGENT_ID);
  assert.equal(config.customAcpAgents[1].command, launch.node);
  assert.deepEqual(config.customAcpAgents[1].args, [launch.bridge]);
  assert.deepEqual(config.customAcpAgents[1].env, { AMP_CLI_PATH: launch.amp });
  assert.equal(inspectInstallation(paths).configured, true);
  const second = provisionInstallation(paths, launch);
  assert.equal(second.changed, false);
});

test("merges an existing hand-written amp entry in place, preserving unknown keys", () => {
  const { launch, paths } = fixture();
  writeFileSync(paths.configPath, JSON.stringify({
    customAcpAgents: [{
      id: AGENT_ID,
      displayName: "Amp (old)",
      command: "/old/amp-acp",
      args: [],
      env: { AMP_CLI_PATH: "/old/amp", AMP_ACP_CONTINUE_LATEST: "1", KEEP_ME: "yes" },
      logo: "amp-logo.svg",
      note: "keep",
    }],
  }));
  provisionInstallation(paths, launch);
  const agents = JSON.parse(readFileSync(paths.configPath, "utf8")).customAcpAgents;
  assert.equal(agents.length, 1);
  const entry = agents[0];
  assert.equal(entry.displayName, "Amp");
  assert.equal(entry.command, launch.node);
  assert.deepEqual(entry.args, [launch.bridge]);
  assert.equal(entry.logo, "logos/amp.svg");
  assert.equal(entry.note, "keep");
  assert.equal(entry.env.AMP_CLI_PATH, launch.amp);
  assert.equal(entry.env.AMP_ACP_CONTINUE_LATEST, undefined);
  assert.equal(entry.env.KEEP_ME, "yes");
});

test("second run after a merge reports no change", () => {
  const { launch, paths } = fixture();
  writeFileSync(paths.configPath, JSON.stringify({
    customAcpAgents: [{ id: AGENT_ID, displayName: "Amp (old)", command: "/old/amp-acp" }],
  }));
  const first = provisionInstallation(paths, launch);
  assert.equal(first.changed, true);
  const second = provisionInstallation(paths, launch);
  assert.equal(second.changed, false);
  assert.equal(inspectInstallation(paths).configured, true);
});

test("refuses to overwrite malformed config", () => {
  const { launch, paths } = fixture();
  writeFileSync(paths.configPath, "{broken");
  assert.throws(() => provisionInstallation(paths, launch));
  assert.equal(readFileSync(paths.configPath, "utf8"), "{broken");
});

test("refuses non-object config", () => {
  const { launch, paths } = fixture();
  writeFileSync(paths.configPath, JSON.stringify(["not", "an", "object"]));
  assert.throws(() => provisionInstallation(paths, launch));
  assert.deepEqual(JSON.parse(readFileSync(paths.configPath, "utf8")), ["not", "an", "object"]);
});

test("rejects a missing bridge bundle with a build hint", () => {
  const { launch, paths, root } = fixture();
  const missing = join(root, "dist", "nope.js");
  assert.throws(
    () => provisionInstallation(paths, { ...launch, bridge: missing }),
    /npm install && npm run build/,
  );
});

test("rejects non-executable node or amp binaries", () => {
  const { launch, paths, root } = fixture();
  const missing = join(root, "nope");
  assert.throws(() => provisionInstallation(paths, { ...launch, node: missing }));
  assert.throws(() => provisionInstallation(paths, { ...launch, amp: missing }));
});
