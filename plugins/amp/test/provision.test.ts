import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_ID,
  OBSOLETE_ORB_AGENT_ID,
  BRIDGE_BUILD_HINT,
  inspectInstallation,
  managedAgentEntry,
  needsProvisioning,
  provisionInstallation,
  resolveAmpCli,
  resolveNodeRuntime,
} from "../lib/provision.ts";
import {
  AMP_LEGACY_RED_LOGO_SVG,
  AMP_LOGO_SVG,
} from "../src/amp-brand.ts";
import { AMP_ACP_EXECUTOR_ENV } from "../src/execution-target.ts";

const EXPECTED_NATIVE_SKILL_ROOTS = {
  user: [
    ".config/agents/skills",
    ".agents/skills",
    ".config/amp/skills",
    ".claude/skills",
  ],
  project: [
    ".agents/skills",
    ".claude/skills",
  ],
};

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

test("managed entry runs node with the bridge bundle and no provider-wide executor", () => {
  const entry = managedAgentEntry({
    node: "/usr/bin/node",
    electron: false,
    bridge: "/plugin/dist/bridge.js",
    amp: "/tmp/amp",
  });

  assert.equal(entry.id, AGENT_ID);
  assert.equal(entry.displayName, "Amp");
  assert.equal(entry.command, "/usr/bin/node");
  assert.deepEqual(entry.args, ["/plugin/dist/bridge.js"]);
  assert.deepEqual(entry.env, { AMP_CLI_PATH: "/tmp/amp" });
  assert.equal("permissionCli" in entry, false);
  assert.equal(entry.logo, "logos/amp.svg");
  assert.equal("nativeReasoning" in entry, false);
  assert.equal("modelCli" in entry, false);
  assert.equal("cwd" in entry, false);
  assert.deepEqual(entry.nativeSkillRoots, EXPECTED_NATIVE_SKILL_ROOTS);
});

test("an Electron host is detected and the entry gets ELECTRON_RUN_AS_NODE=1", () => {
  // bb's own binary: Electron only runs a script as node with this flag set;
  // without it the spawn launches the GUI and bb sees a silent ACP agent.
  const runtime = resolveNodeRuntime(
    "/Applications/bb.app/Contents/MacOS/bb",
    "darwin",
  );
  assert.equal(runtime.electron, true);
  assert.equal(runtime.node, "/Applications/bb.app/Contents/MacOS/bb");

  const entry = managedAgentEntry({
    ...runtime,
    bridge: "/plugin/dist/bridge.js",
    amp: "/tmp/amp",
  });
  assert.deepEqual(entry.env, {
    AMP_CLI_PATH: "/tmp/amp",
    ELECTRON_RUN_AS_NODE: "1",
  });
});

test("a plain node host is not flagged as Electron", () => {
  assert.deepEqual(resolveNodeRuntime("/opt/homebrew/bin/node", "darwin"), {
    node: "/opt/homebrew/bin/node",
    electron: false,
  });
  assert.equal(
    resolveNodeRuntime("C:\\Program Files\\nodejs\\node.exe", "win32").electron,
    false,
  );
});

test("provisioning writes the Electron flag and drops it again on plain node", () => {
  const { launch, paths } = fixture();
  provisionInstallation(paths, { ...launch, electron: true });
  const underElectron = JSON.parse(readFileSync(paths.configPath, "utf8"));
  assert.equal(underElectron.customAcpAgents.length, 1);
  assert.equal(underElectron.customAcpAgents[0].env.ELECTRON_RUN_AS_NODE, "1");

  provisionInstallation(paths, { ...launch, electron: false });
  const underNode = JSON.parse(readFileSync(paths.configPath, "utf8"));
  assert.equal(underNode.customAcpAgents.length, 1);
  assert.equal("ELECTRON_RUN_AS_NODE" in underNode.customAcpAgents[0].env, false);
  assert.equal(underNode.customAcpAgents[0].env.AMP_CLI_PATH, launch.amp);
});

test("fresh install adds one Amp entry without clobbering other config", () => {
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
  assert.equal(config.customAcpAgents[0].id, "other");
  assert.equal(config.customAcpAgents[1].id, AGENT_ID);
  assert.equal(config.customAcpAgents[1].displayName, "Amp");
  assert.equal(config.customAcpAgents[1].command, launch.node);
  assert.deepEqual(config.customAcpAgents[1].args, [launch.bridge]);
  assert.equal("permissionCli" in config.customAcpAgents[1], false);
  assert.deepEqual(config.customAcpAgents[1].env, {
    AMP_CLI_PATH: launch.amp,
  });
  assert.deepEqual(
    config.customAcpAgents[1].nativeSkillRoots,
    EXPECTED_NATIVE_SKILL_ROOTS,
  );
  assert.equal(readFileSync(paths.logoPath, "utf8"), AMP_LOGO_SVG);
  assert.deepEqual(inspectInstallation(paths), {
    configured: true,
    obsoleteOrbConfigured: false,
  });
});

test("provisioning replaces only the managed legacy red provider logo", () => {
  const { launch, paths } = fixture();
  mkdirSync(join(paths.dataDir, "logos"), { recursive: true });
  writeFileSync(paths.logoPath, AMP_LEGACY_RED_LOGO_SVG);

  const result = provisionInstallation(paths, launch);
  assert.equal(result.changed, true);
  assert.equal(readFileSync(paths.logoPath, "utf8"), AMP_LOGO_SVG);
  assert.equal(
    result.messages.includes(`updated managed logo at ${paths.logoPath}`),
    true,
  );
});

test("provisioning preserves an existing provider logo", () => {
  const { launch, paths } = fixture();
  const customLogo = "<svg><!-- custom Amp logo --></svg>\n";
  mkdirSync(join(paths.dataDir, "logos"), { recursive: true });
  writeFileSync(paths.logoPath, customLogo);

  const first = provisionInstallation(paths, launch);
  assert.equal(readFileSync(paths.logoPath, "utf8"), customLogo);
  assert.equal(
    first.messages.includes(`kept existing logo at ${paths.logoPath}`),
    true,
  );

  const second = provisionInstallation(paths, launch);
  assert.equal(second.changed, false);
  assert.equal(readFileSync(paths.logoPath, "utf8"), customLogo);
});

test("merges an existing Amp entry in place and preserves user-owned fields", () => {
  const { launch, paths } = fixture();
  writeFileSync(paths.configPath, JSON.stringify({
    customAcpAgents: [{
      id: AGENT_ID,
      displayName: "Amp (old)",
      command: "/old/amp-acp",
      args: [],
      env: {
        AMP_CLI_PATH: "/old/amp",
        AMP_ACP_CONTINUE_LATEST: "1",
        [AMP_ACP_EXECUTOR_ENV]: "local",
        AMP_API_KEY: "test-api-key",
        XDG_STATE_HOME: "/legacy/state",
        KEEP_ME: "yes",
      },
      logo: "amp-logo.svg",
      note: "keep",
    }],
  }));

  provisionInstallation(paths, launch);

  const agents = JSON.parse(
    readFileSync(paths.configPath, "utf8"),
  ).customAcpAgents;
  assert.equal(agents.length, 1);

  const entry = agents[0];
  assert.equal(entry.id, AGENT_ID);
  assert.equal(entry.displayName, "Amp");
  assert.equal(entry.command, launch.node);
  assert.deepEqual(entry.args, [launch.bridge]);
  assert.equal(entry.logo, "logos/amp.svg");
  assert.equal(entry.note, "keep");
  assert.equal(entry.env.AMP_CLI_PATH, launch.amp);
  assert.equal(entry.env.AMP_ACP_CONTINUE_LATEST, undefined);
  assert.equal(entry.env[AMP_ACP_EXECUTOR_ENV], undefined);
  assert.equal(entry.env.AMP_API_KEY, "test-api-key");
  assert.equal(entry.env.XDG_STATE_HOME, "/legacy/state");
  assert.equal(entry.env.KEEP_ME, "yes");
});

test("removes exact amp-orb entry and merges its env with Amp taking precedence", () => {
  const { launch, paths } = fixture();
  writeFileSync(paths.configPath, JSON.stringify({
    customAcpAgents: [
      { id: "other-before", command: "before" },
      {
        id: OBSOLETE_ORB_AGENT_ID,
        displayName: "Amp Orb",
        command: "/old/orb-bridge",
        env: {
          AMP_CLI_PATH: "/old/orb-amp",
          [AMP_ACP_EXECUTOR_ENV]: "orb",
          AMP_ACP_ORB_PROJECT: "owner/repo",
          ORB_ONLY: "orb",
          SHARED: "orb",
        },
        orbOnlyNote: "preserve",
        note: "orb",
      },
      {
        id: AGENT_ID,
        displayName: "Amp Local",
        command: "/old/local-bridge",
        env: {
          AMP_CLI_PATH: "/old/local-amp",
          [AMP_ACP_EXECUTOR_ENV]: "local",
          AMP_API_KEY: "local-key",
          LOCAL_ONLY: "local",
          SHARED: "local",
        },
        note: "local",
      },
      { id: "other-after", command: "after" },
    ],
  }));

  assert.deepEqual(inspectInstallation(paths), {
    configured: true,
    obsoleteOrbConfigured: true,
  });

  const result = provisionInstallation(paths, launch);
  assert.equal(result.changed, true);
  assert.equal(
    result.messages.some((message) => message.includes("removed obsolete custom ACP agent amp-orb")),
    true,
  );

  const agents = JSON.parse(
    readFileSync(paths.configPath, "utf8"),
  ).customAcpAgents;
  assert.deepEqual(agents.map((entry: { id: string }) => entry.id), [
    "other-before",
    AGENT_ID,
    "other-after",
  ]);

  const entry = agents[1];
  assert.equal(entry.displayName, "Amp");
  assert.equal(entry.command, launch.node);
  assert.equal(entry.note, "local");
  assert.equal(entry.orbOnlyNote, "preserve");
  assert.equal(entry.env.AMP_CLI_PATH, launch.amp);
  assert.equal(entry.env[AMP_ACP_EXECUTOR_ENV], undefined);
  assert.equal(entry.env.AMP_ACP_ORB_PROJECT, "owner/repo");
  assert.equal(entry.env.AMP_API_KEY, "local-key");
  assert.equal(entry.env.ORB_ONLY, "orb");
  assert.equal(entry.env.LOCAL_ONLY, "local");
  assert.equal(entry.env.SHARED, "local");
  assert.deepEqual(inspectInstallation(paths), {
    configured: true,
    obsoleteOrbConfigured: false,
  });
});

test("migrates an orb-only entry to Amp in place", () => {
  const { launch, paths } = fixture();
  writeFileSync(paths.configPath, JSON.stringify({
    customAcpAgents: [
      { id: "before", command: "before" },
      {
        id: OBSOLETE_ORB_AGENT_ID,
        displayName: "Orb (old)",
        command: "/old/bridge",
        env: {
          [AMP_ACP_EXECUTOR_ENV]: "orb",
          AMP_ACP_CONTINUE_LATEST: "1",
          AMP_ACP_ORB_PROJECT: "owner/repo",
          KEEP_ME: "yes",
        },
        note: "keep",
      },
      { id: "after", command: "after" },
    ],
  }));

  const result = provisionInstallation(paths, launch);
  assert.equal(result.changed, true);
  assert.equal(
    result.messages.some((message) => message.includes("migrated custom ACP agent amp-orb to amp")),
    true,
  );

  const agents = JSON.parse(
    readFileSync(paths.configPath, "utf8"),
  ).customAcpAgents;
  assert.deepEqual(agents.map((entry: { id: string }) => entry.id), [
    "before",
    AGENT_ID,
    "after",
  ]);

  const entry = agents[1];
  assert.equal(entry.displayName, "Amp");
  assert.equal(entry.command, launch.node);
  assert.equal(entry.note, "keep");
  assert.equal(entry.env.AMP_CLI_PATH, launch.amp);
  assert.equal(entry.env[AMP_ACP_EXECUTOR_ENV], undefined);
  assert.equal(entry.env.AMP_ACP_CONTINUE_LATEST, undefined);
  assert.equal(entry.env.AMP_ACP_ORB_PROJECT, "owner/repo");
  assert.equal(entry.env.KEEP_ME, "yes");
});

test("leaves similarly named agents untouched", () => {
  const { launch, paths } = fixture();
  const similar = {
    id: "amp-orbit",
    displayName: "Amp Orbit",
    command: "/custom/orbit",
    env: { KEEP_ME: "yes" },
  };
  writeFileSync(paths.configPath, JSON.stringify({
    customAcpAgents: [similar],
  }));

  provisionInstallation(paths, launch);

  const agents = JSON.parse(
    readFileSync(paths.configPath, "utf8"),
  ).customAcpAgents;
  assert.equal(agents.length, 2);
  assert.deepEqual(agents[0], similar);
  assert.equal(agents[1].id, AGENT_ID);
});

test("provisioning is idempotent after collapsing legacy entries", () => {
  const { launch, paths } = fixture();
  writeFileSync(paths.configPath, JSON.stringify({
    customAcpAgents: [
      {
        id: AGENT_ID,
        command: "/old/local",
        env: { LOCAL_ONLY: "local" },
      },
      {
        id: OBSOLETE_ORB_AGENT_ID,
        command: "/old/orb",
        env: { ORB_ONLY: "orb" },
      },
    ],
  }));

  const first = provisionInstallation(paths, launch);
  assert.equal(first.changed, true);
  const afterFirst = readFileSync(paths.configPath, "utf8");

  const second = provisionInstallation(paths, launch);
  assert.equal(second.changed, false);
  assert.equal(readFileSync(paths.configPath, "utf8"), afterFirst);
  assert.deepEqual(inspectInstallation(paths), {
    configured: true,
    obsoleteOrbConfigured: false,
  });
});

test("the automatic pass provisions a config with no Amp entry", () => {
  const { launch, paths } = fixture();
  assert.equal(needsProvisioning(paths, launch), true);

  provisionInstallation(paths, launch);
  assert.equal(needsProvisioning(paths, launch), false);
});

test("the automatic pass upgrades an Amp entry without native skill roots", () => {
  const { launch, paths } = fixture();
  provisionInstallation(paths, launch);

  const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
  delete config.customAcpAgents[0].nativeSkillRoots;
  writeFileSync(paths.configPath, JSON.stringify(config));

  assert.equal(needsProvisioning(paths, launch), true);
  provisionInstallation(paths, launch);
  const repaired = JSON.parse(readFileSync(paths.configPath, "utf8"));
  assert.deepEqual(
    repaired.customAcpAgents[0].nativeSkillRoots,
    EXPECTED_NATIVE_SKILL_ROOTS,
  );
  assert.equal(needsProvisioning(paths, launch), false);
});

test("the automatic pass leaves a working hand-edited entry alone", () => {
  const { launch, paths, bin } = fixture();
  provisionInstallation(paths, launch);

  const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
  config.customAcpAgents[0].env.AMP_API_KEY = "user-key";
  config.customAcpAgents[0].env.AMP_CLI_PATH = fakeExecutable(bin, "amp-nightly");
  writeFileSync(paths.configPath, JSON.stringify(config));

  assert.equal(needsProvisioning(paths, launch), false);
});

test("the automatic pass rewrites an entry whose Amp CLI is gone", () => {
  const { launch, paths, root } = fixture();
  provisionInstallation(paths, launch);

  const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
  config.customAcpAgents[0].env.AMP_CLI_PATH = join(root, "removed-amp");
  writeFileSync(paths.configPath, JSON.stringify(config));

  assert.equal(needsProvisioning(paths, launch), true);
});

test("the automatic pass removes unsupported permission routing from an older entry", () => {
  const { launch, paths } = fixture();
  provisionInstallation(paths, launch);

  const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
  config.customAcpAgents[0].permissionCli = {
    full: ["--bb-permission-full"],
  };
  writeFileSync(paths.configPath, JSON.stringify(config));

  assert.equal(needsProvisioning(paths, launch), true);
  provisionInstallation(paths, launch);
  const repaired = JSON.parse(readFileSync(paths.configPath, "utf8"));
  assert.equal("permissionCli" in repaired.customAcpAgents[0], false);
});

test("the automatic pass rewrites an entry left on an older bridge or runtime", () => {
  const { launch, paths, root } = fixture();
  provisionInstallation(paths, launch);

  assert.equal(
    needsProvisioning(paths, { ...launch, bridge: join(root, "v2", "bridge.js") }),
    true,
  );
  assert.equal(
    needsProvisioning(paths, { ...launch, node: join(root, "bin", "node22") }),
    true,
  );
});

test("the automatic pass migrates an obsolete amp-orb entry", () => {
  const { launch, paths } = fixture();
  writeFileSync(paths.configPath, JSON.stringify({
    customAcpAgents: [{ id: OBSOLETE_ORB_AGENT_ID, command: "/old/orb" }],
  }));

  assert.equal(needsProvisioning(paths, launch), true);
});

test("the automatic pass reports a config it cannot read without changing it", () => {
  const { launch, paths } = fixture();
  writeFileSync(paths.configPath, "{broken");
  assert.throws(() => needsProvisioning(paths, launch));
  assert.equal(readFileSync(paths.configPath, "utf8"), "{broken");
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
  assert.deepEqual(
    JSON.parse(readFileSync(paths.configPath, "utf8")),
    ["not", "an", "object"],
  );
});

test("rejects a missing bridge bundle with a build hint", () => {
  const { launch, paths, root } = fixture();
  const missing = join(root, "dist", "nope.js");
  assert.throws(
    () => provisionInstallation(paths, { ...launch, bridge: missing }),
    (error: unknown) => error instanceof Error
      && error.message.includes(BRIDGE_BUILD_HINT),
  );
});

test("rejects non-executable node or amp binaries", () => {
  const { launch, paths, root } = fixture();
  const missing = join(root, "nope");
  assert.throws(() => provisionInstallation(paths, { ...launch, node: missing }));
  assert.throws(() => provisionInstallation(paths, { ...launch, amp: missing }));
});
