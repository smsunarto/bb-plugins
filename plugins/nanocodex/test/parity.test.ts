// Replay layer: committed recordings under test/recordings/nanocodex/ run
// through the real built bridge (dist/host.js via the SDK's worker bootstrap)
// and the replay must reproduce what was recorded — the check that a refactor
// did not change a byte on the wire.
//
// DEFAULT_REPLAY_PROFILE is for bridges with no provider child. This bridge
// spawns a real nanocodex child per turn, so the profile substitutes the
// recorded provider->bridge lane for the CLI: the replay child speaks the
// "claude-cli" dialect (one-way JSON lines on stdout, which is exactly the
// nanocodex event stream), and the bridge is pointed at it through the same
// env overrides the fake-CLI tests use.
//
// Recordings need a real signed-in nanocodex account, so none ship with the
// plugin yet; the test skips until someone records with
// BB_PROVIDER_BRIDGE_RECORD_DIR and commits the capture. Everything above
// this layer runs with no network and no account.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  experimental_assembleRecordedEvents as assembleRecordedEvents,
  experimental_checkRecordedCellReplay as checkRecordedCellReplay,
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  experimental_listRecordedCells as listRecordedCells,
  experimental_readBridgeRecording as readBridgeRecording,
  experimental_replayRecording as replayRecording,
  experimental_resolveProviderBridgeLaunch as resolveProviderBridgeLaunch,
  type ReplayProviderProfile,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  NANOCODEX_ARGS_OVERRIDE_ENV,
  NANOCODEX_COMMAND_OVERRIDE_ENV,
} from "../src/catalog.ts";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_MODULE = join(PLUGIN_ROOT, "dist", "host.js");
const RECORDINGS_ROOT = join(PLUGIN_ROOT, "test", "recordings");

const NANOCODEX_REPLAY_PROFILE: ReplayProviderProfile = {
  dialect: "claude-cli",
  env: ({ replayCommand }) => ({
    [NANOCODEX_COMMAND_OVERRIDE_ENV]: replayCommand[0] ?? "",
    [NANOCODEX_ARGS_OVERRIDE_ENV]: JSON.stringify(replayCommand.slice(1)),
  }),
};

const parityTest =
  existsSync(HOST_MODULE) && existsSync(join(RECORDINGS_ROOT, "nanocodex"))
    ? test
    : test.skip;

parityTest("the built bridge replays the recorded parity cells", async () => {
  const cells = listRecordedCells(RECORDINGS_ROOT).filter((cell) => cell.provider === "nanocodex");
  assert.ok(cells.length > 0, "test/recordings/nanocodex exists but holds no cells");

  for (const cell of cells) {
    const dataDir = join(PLUGIN_ROOT, "test", ".parity-replay", cell.cell);
    mkdirSync(dataDir, { recursive: true });
    const launch = resolveProviderBridgeLaunch({
      modulePath: HOST_MODULE,
      pluginId: "nanocodex",
      dataDir,
    });
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const run = await replayRecording({
      recordingDir: cell.dir,
      providerId: cell.provider,
      bridge: { ...launch, env: { ...inheritedEnv, ...launch.env } },
      profile: NANOCODEX_REPLAY_PROFILE,
      createAssembler: createBridgeDeltaEventCollector,
      timeoutMs: 20_000,
    });
    assert.deepEqual(run.stalls, [], `${cell.cell}: ${run.stalls.join("; ")}\n${run.stderr}`);
    assert.deepEqual(
      run.grammarViolations,
      [],
      `${cell.cell}: ${JSON.stringify(run.grammarViolations)}`,
    );
    const recorded = assembleRecordedEvents(
      readBridgeRecording(cell.dir),
      createBridgeDeltaEventCollector,
      cell.provider,
    );
    assert.deepEqual(recorded.invalidDeltas, [], `${cell.cell} recording has invalid deltas`);
    const verdicts = checkRecordedCellReplay({
      provider: cell.provider,
      cell: cell.cell,
      events: run.events,
      recordedEvents: recorded.events,
      stalls: run.stalls,
    });
    for (const verdict of verdicts) {
      assert.equal(verdict.status, "pass", `${verdict.id}: ${verdict.detail ?? ""}`);
    }
  }
});
