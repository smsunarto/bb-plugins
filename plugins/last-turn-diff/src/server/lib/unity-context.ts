import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { join } from "node:path";
import { isUnityAsset, type UnityDiff } from "@bb-plugins/unity-inspector/model";
import { buildUnityDiff } from "@bb-plugins/unity-inspector/parse";
import { applyUnityPatch } from "@bb-plugins/unity-inspector/patch";
import type { Change } from "../../shared/contract.ts";

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

/** Load only the expanded edit. The memo owner caches this result with its exact turn revision. */
export async function loadUnityContext(
  bb: BbPluginApi,
  environment: { hostId: string; path: string } | null,
  change: Change,
): Promise<UnityDiff | null> {
  const path = change.workspace === undefined ? (change.relPath ?? change.path) : change.path;
  if (!environment || !isUnityAsset(change.path) || !change.patch || !safePath(path)) return null;
  try {
    const current = await loadCurrent(bb, environment, path, change.patch);
    const result = recordedUnityDiff(change.patch, current);
    return result.groups.length ? result : null;
  } catch {
    // Missing, binary, moved, or mismatched sources retain the recorded YAML diff.
    return null;
  }
}
