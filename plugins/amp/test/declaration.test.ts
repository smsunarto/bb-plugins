import assert from "node:assert/strict";
import test from "node:test";
import { validatePluginProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { experimental_acpLaunchSpecSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { buildAmpProviderDeclaration, type BridgeLaunch } from "../lib/declaration.ts";
import { AMP_NATIVE_SKILL_ROOTS } from "../lib/provision.ts";
import { AMP_MODES, CONFIG_MODE } from "../src/bridge-core.ts";

const PLAIN_NODE: BridgeLaunch = {
  node: "/usr/local/bin/node",
  electron: false,
  bridge: "/plugin/dist/bridge.js",
  amp: "/usr/local/bin/amp",
};

const ELECTRON: BridgeLaunch = {
  node: "/Applications/bb.app/Contents/MacOS/bb",
  electron: true,
  bridge: "/plugin/dist/bridge.js",
  amp: "/opt/homebrew/bin/amp",
};

function launchSpec(launch: BridgeLaunch) {
  return buildAmpProviderDeclaration(launch).experimental_bridgeOptions?.acpLaunchSpec as Record<
    string,
    unknown
  >;
}

test("the declaration passes the SDK validator", () => {
  const normalized = validatePluginProviderDeclaration(buildAmpProviderDeclaration(PLAIN_NODE));
  assert.equal(normalized.id, "acp-amp");
  assert.equal(normalized.displayName, "Amp");
  assert.equal(normalized.family, "acp");
  assert.equal(normalized.icon, "./assets/icon.svg");
  assert.equal(normalized.maintenance?.health, true);
  assert.deepEqual(normalized.capabilities, {
    supportsServiceTier: false,
    supportsNativeUserQuestion: false,
    fork: "none",
    supportsManualCompaction: false,
    supportsThreadArchive: false,
    supportsThreadRename: false,
    permissionModes: ["accept-edits", "full"],
    reasoningLevels: ["low", "medium", "high", "ultra"],
  });
  assert.deepEqual(normalized.composerActions, []);
});

test("the launch spec parses under the ACP bridge schema", () => {
  for (const launch of [PLAIN_NODE, ELECTRON]) {
    const parsed = experimental_acpLaunchSpecSchema.parse(launchSpec(launch));
    assert.equal(parsed.command, launch.node);
    assert.deepEqual(parsed.args, [launch.bridge]);
    assert.deepEqual(parsed.nativeSkillRoots, AMP_NATIVE_SKILL_ROOTS);
  }
});

test("a plain-node launch sets only AMP_CLI_PATH", () => {
  const declaration = buildAmpProviderDeclaration(PLAIN_NODE);
  assert.equal(declaration.experimental_bridgeOptions?.acpDialect, "generic");
  assert.deepEqual(launchSpec(PLAIN_NODE).env, { AMP_CLI_PATH: PLAIN_NODE.amp });
});

test("an Electron launch adds ELECTRON_RUN_AS_NODE", () => {
  assert.deepEqual(launchSpec(ELECTRON).env, {
    AMP_CLI_PATH: ELECTRON.amp,
    ELECTRON_RUN_AS_NODE: "1",
  });
});

test("nativeReasoning mirrors the bridge's mode config", () => {
  const reasoning = launchSpec(PLAIN_NODE).nativeReasoning as {
    configId: string;
    supportedLevels: string[];
    defaultLevel: string;
  };
  assert.equal(reasoning.configId, CONFIG_MODE);
  const bridgeModes: string[] = AMP_MODES.map((mode) => mode.value);
  assert.deepEqual(reasoning.supportedLevels, bridgeModes);
  assert.ok(bridgeModes.includes(reasoning.defaultLevel));
  assert.equal(reasoning.defaultLevel, "medium");
});
