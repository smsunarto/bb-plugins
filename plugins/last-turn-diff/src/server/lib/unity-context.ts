import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { join } from "node:path";
import { isUnityAsset, type UnityDiff } from "@bb-plugins/unity-inspector/model";
import { buildUnityDiff } from "@bb-plugins/unity-inspector/parse";
import { applyUnityPatch } from "@bb-plugins/unity-inspector/patch";
import type { LatestTurn } from "../../shared/contract.ts";
import { turnChanges } from "../../shared/patches.ts";

/** Changed values always come from the recorded patch. Workspace text supplies object context. */
export function recordedUnityDiff(patch: string, current: string): UnityDiff {
  const deleted = /^\+\+\+ \/dev\/null$/m.test(patch);
  const added = /^--- \/dev\/null$/m.test(patch);
  const after = deleted ? "" : added ? applyUnityPatch("", patch) : current;
  const before = added ? "" : applyUnityPatch(after, patch, true);
  return buildUnityDiff(before, after, patch);
}

function safePath(path: string): boolean {
  return (
    !/[\\\0\r\n]/.test(path) &&
    !path.split("/").some((part) => !part || part === "." || part === "..")
  );
}

async function loadCurrent(
  bb: BbPluginApi,
  environment: { hostId: string; path: string },
  path: string,
  patch: string,
): Promise<string> {
  if (/^(?:---|\+\+\+) \/dev\/null$/m.test(patch)) return "";
  const file = await bb.sdk.files.read({
    hostId: environment.hostId,
    path: join(environment.path, path),
    rootPath: environment.path,
  });
  if (
    file.contentEncoding !== "utf8" ||
    new TextEncoder().encode(file.content).byteLength > 1_500_000
  )
    throw new Error("Unsupported Unity source");
  return file.content;
}

export async function addUnityContext(
  bb: BbPluginApi,
  threadId: string,
  turn: LatestTurn,
): Promise<LatestTurn> {
  const candidates = turnChanges(turn).filter(
    (change) => isUnityAsset(change.path) && change.patch && safePath(change.path),
  );
  if (!candidates.length) return turn;
  const unity: Record<string, UnityDiff> = {};
  try {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return turn;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (!environment.path) return turn;
    let remaining = 6_000_000;
    for (const change of candidates) {
      try {
        const current = await loadCurrent(
          bb,
          { hostId: environment.hostId, path: environment.path },
          change.workspace === undefined ? (change.relPath ?? change.path) : change.path,
          change.patch!,
        );
        remaining -= new TextEncoder().encode(current).byteLength;
        if (remaining < 0) break;
        const result = recordedUnityDiff(change.patch!, current);
        if (result.groups.length) unity[change.id] = result;
      } catch {
        // Missing, binary, moved or malformed sources keep the original recorded patch.
      }
    }
  } catch {
    return turn;
  }
  return Object.keys(unity).length ? { ...turn, unity } : turn;
}
