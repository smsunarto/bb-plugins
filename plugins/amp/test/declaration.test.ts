// Must be first: bb SDK modules expect a CJS-style global require.
import "./helpers/global-require.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { validatePluginProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import {
  buildAmpProviderDeclaration,
  oracleReceiptSchema,
  threadLinkStateSchema,
  type AmpProviderPaths,
} from "../lib/declaration.ts";
import { AMP_NATIVE_SKILL_ROOTS } from "../lib/provision.ts";
import { AMP_ORACLE_KIND, AMP_THREAD_LINK_KIND } from "../src/bridge/shapes.ts";

const PATHS: AmpProviderPaths = {
  ampCliPath: "/plugin/dist/amp-cli-shim.js",
  ampRealCliPath: "/usr/local/bin/amp",
};

test("the declaration passes the SDK validator", () => {
  const normalized = validatePluginProviderDeclaration(buildAmpProviderDeclaration(PATHS));
  assert.equal(normalized.id, "acp-amp");
  assert.equal(normalized.displayName, "Amp");
  assert.equal(normalized.icon, "./assets/icon.svg");
  // The ACP era is over: no family grouping, no launch spec.
  assert.equal(normalized.family, undefined);
  assert.equal(normalized.experimental_bridgeOptions, undefined);
  assert.deepEqual(normalized.capabilities, {
    supportsServiceTier: true,
    supportsNativeUserQuestion: false,
    fork: "none",
    supportsManualCompaction: false,
    supportsThreadArchive: true,
    supportsThreadRename: true,
    permissionModes: ["accept-edits", "full"],
    reasoningLevels: ["low", "medium", "high", "ultra"],
  });
  assert.deepEqual(normalized.composerActions, []);
  assert.deepEqual(normalized.env, {
    passthrough: ["AMP_CLI_PATH", "AMP_URL", "AMP_API_KEY"],
  });
  // The validator normalizes skill-root strings into descriptor objects;
  // the paths are the contract.
  const skillRoots = normalized.experimental_nativeSkillRoots;
  const rootPath = (root: string | { path: string }) =>
    typeof root === "string" ? root : root.path;
  assert.deepEqual(skillRoots?.project?.map(rootPath), AMP_NATIVE_SKILL_ROOTS.project);
  assert.deepEqual(skillRoots?.user?.map(rootPath), AMP_NATIVE_SKILL_ROOTS.user);
  assert.deepEqual(normalized.models, { scope: "host" });
});

test("service tiers and reasoning levels pin the wire ids the bridge maps", () => {
  const declaration = buildAmpProviderDeclaration(PATHS);
  // options.ts: `serviceTier === "fast"` selects Amp's fast mode.
  assert.deepEqual(
    declaration.serviceTiers?.map((tier) => tier.id),
    ["default", "fast"],
  );
  // options.ts modeFor: the four Amp modes behind bb's reasoning ladder.
  assert.deepEqual(
    declaration.reasoningLevels?.map((level) => level.id),
    ["low", "medium", "high", "ultra"],
  );
});

test("extension kind keys prefix to the bridge's wire values", () => {
  const declaration = buildAmpProviderDeclaration(PATHS);
  const kinds = declaration.extensionKinds ?? {};
  assert.deepEqual(Object.keys(kinds).sort(), ["oracle", "thread-link"]);
  // bb prefixes the plugin id ("amp"); the bridge emits these full names.
  assert.equal(AMP_ORACLE_KIND, "amp/oracle");
  assert.equal(AMP_THREAD_LINK_KIND, "amp/thread-link");
  assert.ok(kinds["oracle"]?.item);
  assert.equal(kinds["oracle"]?.state, undefined);
  assert.ok(kinds["thread-link"]?.state);
  assert.equal(kinds["thread-link"]?.item, undefined);
});

test("the oracle receipt schema accepts the bridge payload", () => {
  assert.deepEqual(oracleReceiptSchema.parse({ reportId: "report-1", question: "why?" }), {
    reportId: "report-1",
    question: "why?",
  });
  assert.equal(oracleReceiptSchema.safeParse({ question: "missing id" }).success, false);
  assert.equal(oracleReceiptSchema.safeParse({ reportId: "", question: "" }).success, false);
});

test("the thread-link schema accepts local and orb states", () => {
  for (const payload of [
    { ampThreadId: null, executionTarget: "local", syncCommand: null },
    { ampThreadId: "T-abc", executionTarget: "local", syncCommand: null },
    { ampThreadId: null, executionTarget: "orb", syncCommand: null },
    { ampThreadId: "T-abc", executionTarget: "orb", syncCommand: "amp sync T-abc" },
  ]) {
    assert.equal(threadLinkStateSchema.safeParse(payload).success, true, JSON.stringify(payload));
  }
  assert.equal(
    threadLinkStateSchema.safeParse({
      ampThreadId: "T-abc",
      executionTarget: "remote",
      syncCommand: null,
    }).success,
    false,
  );
});

test("deriveProviderOptions returns the closed-over paths", () => {
  const declaration = buildAmpProviderDeclaration(PATHS);
  const options = declaration.deriveProviderOptions?.({
    threadId: "thr_1",
    projectId: "prj_1",
    model: "default",
    permissionMode: "full",
    settings: {},
  });
  assert.deepEqual(options, {
    ampCliPath: PATHS.ampCliPath,
    ampRealCliPath: PATHS.ampRealCliPath,
  });
});
