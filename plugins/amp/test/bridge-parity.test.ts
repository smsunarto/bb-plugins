// Replays the committed recordings under test/recordings/acp-amp/ through the
// real built bridge (dist/host.js via the SDK's worker bootstrap) and checks
// the replay reproduces what was recorded. Refresh the recordings with
// test/helpers/record-parity.ts when the wire behavior changes on purpose.
//
// Four of the SDK's eight conformance cells are recorded; the other four do
// not exist for this provider (see parity-fixture.ts).
// Must be first: bb SDK modules expect a CJS-style global require.
import "./helpers/global-require.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_REPLAY_PROFILE,
  experimental_assembleRecordedEvents as assembleRecordedEvents,
  experimental_checkRecordedCellReplay as checkRecordedCellReplay,
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  experimental_listRecordedCells as listRecordedCells,
  experimental_readBridgeRecording as readBridgeRecording,
  experimental_replayRecording as replayRecording,
  experimental_resolveProviderBridgeLaunch as resolveProviderBridgeLaunch,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  FAKE_CLI,
  PARITY_CELLS,
  PARITY_ROOT,
  prepareParityRoot,
} from "./helpers/parity-fixture.ts";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_MODULE = join(PLUGIN_ROOT, "dist", "host.js");
const RECORDINGS_ROOT = join(PLUGIN_ROOT, "test", "recordings");

test("the built bridge replays the recorded parity cells", async (t) => {
  if (!existsSync(HOST_MODULE)) {
    // Same self-skip the retired stdio test used: recordings replay the
    // built artifact, and an unbuilt checkout has nothing to replay.
    t.skip(`dist/host.js is unbuilt — run \`bun run build\`, then rerun for parity coverage`);
    return;
  }
  // The recordings reference fixed paths (the fake CLI, the workspace cwd);
  // recreate them so the replayed bridge can spawn its provider for real.
  prepareParityRoot();
  const fakeCli = join(PARITY_ROOT, "fake-amp.mjs");
  writeFileSync(fakeCli, FAKE_CLI, "utf8");
  chmodSync(fakeCli, 0o755);

  const cells = listRecordedCells(RECORDINGS_ROOT).filter((cell) => cell.provider === "acp-amp");
  assert.deepEqual(
    cells.map((cell) => cell.cell).sort(),
    [...PARITY_CELLS].sort(),
    "the committed recordings drifted from the declared parity cells",
  );

  for (const cell of cells) {
    const launch = resolveProviderBridgeLaunch({
      modulePath: HOST_MODULE,
      pluginId: "amp",
      dataDir: join(PARITY_ROOT, "replay-data", cell.cell),
    });
    const run = await replayRecording({
      recordingDir: cell.dir,
      providerId: cell.provider,
      bridge: { ...launch, env: { ...process.env, ...launch.env, AMP_CLI_PATH: fakeCli } },
      profile: DEFAULT_REPLAY_PROFILE,
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
