import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  snapshotHostContract,
  type CaptureKind,
  type SnapshotPatch,
} from "../../shared/host-contract.ts";
import type { TurnRow } from "./build-latest-turn.ts";
import { isFileChangeRow } from "./workspace-attribution.ts";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
export type Target = { hostId: string; environmentPath: string };
export type TurnWindow = { startedAt: number; completedAt: number };

function client(bb: BbPluginApi) {
  return bb.hosts.experimental_client({ contract: snapshotHostContract });
}

/** The thread's checkout, or null when it has none yet. */
export async function resolveTarget(
  bb: BbPluginApi,
  thread: Pick<Thread, "environmentId">,
): Promise<Target | null> {
  if (!thread.environmentId) return null;
  const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
  return environment.path
    ? { hostId: environment.hostId, environmentPath: environment.path }
    : null;
}

export async function captureWorkspace(
  bb: BbPluginApi,
  target: Target,
  threadId: string,
  kind: CaptureKind,
  at = Date.now(),
): Promise<void> {
  await client(bb).call(
    "capture",
    { environmentPath: target.environmentPath, threadId, at, kind },
    { hostId: target.hostId },
  );
}

export async function forgetWorkspace(
  bb: BbPluginApi,
  target: Target,
  threadId: string,
): Promise<void> {
  await client(bb).call(
    "forget",
    { environmentPath: target.environmentPath, threadId },
    { hostId: target.hostId },
  );
}

/** Paths this turn's provider recorded editing, as it reported them. */
function recordedPaths(rows: TurnRow[]): string[] {
  const paths = new Set<string>();
  for (const row of rows) {
    if (!isFileChangeRow(row)) continue;
    paths.add(row.change.path);
    if (row.change.movePath) paths.add(row.change.movePath);
  }
  return [...paths].slice(0, 1000);
}

/** The diff between the workspace captures bracketing a turn, when both exist. */
export async function snapshotPatch(
  bb: BbPluginApi,
  target: Target,
  threadId: string,
  window: TurnWindow,
  rows: TurnRow[],
): Promise<SnapshotPatch | null> {
  const { snapshot } = await client(bb).call(
    "turnPatch",
    {
      environmentPath: target.environmentPath,
      threadId,
      ...window,
      recordedPaths: recordedPaths(rows),
    },
    { hostId: target.hostId },
  );
  return snapshot;
}
