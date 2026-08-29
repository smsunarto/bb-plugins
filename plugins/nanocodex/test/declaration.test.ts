// Static layer: the declaration through the SDK's own validator, plus the
// declaration/handshake pairs nothing else keeps honest. The declaration is
// server-side UX facts and the handshake is bridge behavior facts; nothing
// synchronizes them at runtime, so these tests are the synchronization.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { validatePluginProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import {
  buildNanocodexProviderDeclaration,
  type NanocodexProviderPaths,
  type NanocodexSettings,
} from "../lib/declaration.ts";
import {
  DEFAULT_HISTORY_BUDGET_BYTES,
  NANOCODEX_MODELS,
  NANOCODEX_REASONING_LEVELS,
  NANOCODEX_WIRE_MODELS,
} from "../src/catalog.ts";
import { CAPABILITIES } from "../src/bridge/entry.ts";
import { buildRunArgv, toRunSpec } from "../src/bridge/run.ts";

const PATHS: NanocodexProviderPaths = { nanocodexCliPath: "/usr/local/bin/nanocodex" };

const SETTINGS: NanocodexSettings = {
  historyBudgetKb: 60,
  subagents: true,
  webSearch: true,
  imageGeneration: false,
  mcpDefaults: true,
};

function declaration() {
  return buildNanocodexProviderDeclaration(PATHS, () => SETTINGS);
}

test("the declaration passes the SDK validator", () => {
  const normalized = validatePluginProviderDeclaration(declaration());
  assert.equal(normalized.id, "nanocodex");
  assert.equal(normalized.displayName, "nanocodex");
  assert.equal(normalized.icon, "./assets/icon.svg");
  assert.deepEqual(normalized.capabilities, {
    supportsServiceTier: true,
    supportsNativeUserQuestion: false,
    fork: "checkpoint",
    supportsManualCompaction: true,
    supportsThreadArchive: false,
    supportsThreadRename: false,
    permissionModes: ["full"],
    reasoningLevels: NANOCODEX_REASONING_LEVELS,
  });
  assert.deepEqual(normalized.composerActions, []);
  assert.deepEqual(normalized.models, { scope: "host", fallback: NANOCODEX_MODELS });
});

test("declaration and handshake agree where the protocol lets them drift", () => {
  const d = declaration();
  // fork: the handshake may narrow the declaration but never widen it.
  assert.equal(d.capabilities.fork, "checkpoint");
  assert.equal(CAPABILITIES.fork, "checkpoint");
  // permissionModes ["full"] is the declaration's face of the handshake's
  // approvalEnforcedBy "provider": the child pauses for nothing.
  assert.deepEqual(d.capabilities.permissionModes, ["full"]);
  assert.equal(CAPABILITIES.approvalEnforcedBy, "provider");
});

test("every declared reasoning level maps onto --thinking, and no other", () => {
  const spec = (reasoningLevel: string | undefined) =>
    toRunSpec({
      options: {
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
        ...(reasoningLevel === undefined ? {} : { reasoningLevel: reasoningLevel as never }),
      },
      cwd: "/repo",
      prompt: "p",
      instructions: null,
      launch: { command: "/usr/local/bin/nanocodex", argsPrefix: [] },
      features: { subagents: true, webSearch: true, imageGeneration: true, mcpDefaults: true },
    });
  for (const level of NANOCODEX_REASONING_LEVELS) {
    const argv = buildRunArgv(spec(level));
    const flagIndex = argv.indexOf("--thinking");
    assert.ok(flagIndex >= 0, `--thinking present for ${level}`);
    assert.equal(argv[flagIndex + 1], level);
  }
  // Undeclared levels omit the flag rather than guessing.
  for (const level of ["ultra", "ultracode", undefined]) {
    assert.equal(buildRunArgv(spec(level)).includes("--thinking"), false);
  }
});

test("service tier 'fast' is the only tier that adds --fast-mode", () => {
  const d = declaration();
  assert.deepEqual(
    d.serviceTiers?.map((tier) => tier.id),
    ["default", "fast"],
  );
  const spec = (serviceTier: "default" | "fast" | undefined) =>
    toRunSpec({
      options: {
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
        ...(serviceTier === undefined ? {} : { serviceTier }),
      },
      cwd: "/repo",
      prompt: "p",
      instructions: null,
      launch: { command: "/usr/local/bin/nanocodex", argsPrefix: [] },
      features: { subagents: true, webSearch: true, imageGeneration: true, mcpDefaults: true },
    });
  const fastArgv = buildRunArgv(spec("fast"));
  const fastIndex = fastArgv.indexOf("--fast-mode");
  assert.ok(fastIndex >= 0, "--fast-mode present for the fast tier");
  assert.equal(fastArgv[fastIndex + 1], "true");
  assert.equal(buildRunArgv(spec("default")).includes("--fast-mode"), false);
  assert.equal(buildRunArgv(spec(undefined)).includes("--fast-mode"), false);
});

test("every argv disables the browser with the single-token = form", () => {
  // Omitting the flag inherits the `brave` default, which hard-fails at
  // startup on machines without a Brave profile; the space form is a clap
  // parse error because the value is optional.
  const argv = buildRunArgv(
    toRunSpec({
      options: {
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      cwd: "/repo",
      prompt: "p",
      instructions: null,
      launch: { command: "/usr/local/bin/nanocodex", argsPrefix: [] },
      features: { subagents: true, webSearch: true, imageGeneration: true, mcpDefaults: true },
    }),
  );
  assert.ok(argv.includes("--browser=none"));
  assert.equal(argv.includes("--browser"), false);
});

test("the declaration fallback and the bridge's model/list serve the same catalog", () => {
  const d = declaration();
  assert.deepEqual(
    d.models?.fallback?.map((model) => model.id),
    NANOCODEX_WIRE_MODELS.map((model) => model.id),
  );
  // model/list additionally carries the raw provider string, which for
  // nanocodex IS the bb id (the CLI documents the full ids as --model values).
  for (const model of NANOCODEX_WIRE_MODELS) {
    assert.equal(model.model, model.id);
  }
  assert.equal(NANOCODEX_MODELS.filter((model) => model.isDefault).length, 1);
  for (const model of NANOCODEX_MODELS) {
    assert.deepEqual(
      model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
      NANOCODEX_REASONING_LEVELS,
    );
    assert.ok(
      (NANOCODEX_REASONING_LEVELS as readonly string[]).includes(model.defaultReasoningEffort),
    );
  }
});

test("deriveProviderOptions reads the settings thunk at call time", () => {
  let current = SETTINGS;
  const d = buildNanocodexProviderDeclaration(PATHS, () => current);
  const context = {
    threadId: "thr_1",
    projectId: "prj_1",
    model: "gpt-5.6-sol",
    permissionMode: "full" as const,
    settings: {},
  };
  assert.deepEqual(d.deriveProviderOptions?.(context), {
    nanocodexCliPath: PATHS.nanocodexCliPath,
    historyBudgetBytes: 60 * 1024,
    features: { subagents: true, webSearch: true, imageGeneration: false, mcpDefaults: true },
  });
  current = { ...SETTINGS, historyBudgetKb: Number.NaN, webSearch: false };
  const options = d.deriveProviderOptions?.(context) as Record<string, unknown>;
  // A non-numeric budget setting falls back to the default instead of NaN.
  assert.equal(options.historyBudgetBytes, DEFAULT_HISTORY_BUDGET_BYTES);
  assert.deepEqual(options.features, {
    subagents: true,
    webSearch: false,
    imageGeneration: false,
    mcpDefaults: true,
  });
});
