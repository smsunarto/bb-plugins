import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { UnityDiff } from "../../shared/unity-diff.ts";
import { buildUnityDiff } from "./unity-diff.ts";
import { applyUnityPatch } from "./unity-patch.ts";

const MAX_BYTES = 1_500_000;

async function readBase(
  bb: BbPluginApi,
  environmentId: string,
  mergeBase: string | null | undefined,
  path: string,
  patch: string,
) {
  if (/^--- \/dev\/null$/m.test(patch)) return "";
  const target = mergeBase
    ? { target: "all" as const, mergeBaseBranch: mergeBase }
    : { target: "uncommitted" as const };
  const files = await bb.sdk.environments.diffFiles({ environmentId, ...target });
  if (files.outcome !== "available") throw new Error("Unity diff metadata unavailable");
  const entry = files.files.find((file) => file.path === path);
  if (!entry || entry.binary) throw new Error("Unity asset unavailable or binary");
  // diffFile requires the resolved SHA, not the display branch name. Renames read the old path.
  const oldTarget = mergeBase
    ? { target: "all" as const, mergeBaseRef: files.mergeBaseRef! }
    : { target: "uncommitted" as const };
  if (mergeBase && !files.mergeBaseRef) throw new Error("Unity merge base unavailable");
  const base = await bb.sdk.environments.diffFile({
    environmentId,
    path: entry.previousPath ?? path,
    side: "old",
    ...oldTarget,
  });
  if (
    base.contentEncoding !== "utf8" ||
    base.sizeBytes > MAX_BYTES ||
    new TextEncoder().encode(base.content).byteLength > MAX_BYTES
  ) {
    throw new Error("Unity base is not bounded UTF-8 text");
  }
  return base.content;
}

export async function loadUnityDiff(
  bb: BbPluginApi,
  environmentId: string,
  mergeBase: string | null | undefined,
  path: string,
  file: { patch: string; truncated: boolean },
  selectedPatch: string,
): Promise<{ unity?: UnityDiff; unityNotice?: string }> {
  try {
    if (file.truncated) throw new Error("Truncated patch");
    const before = await readBase(bb, environmentId, mergeBase, path, file.patch);
    const after = applyUnityPatch(before, file.patch);
    if (new TextEncoder().encode(after).byteLength > MAX_BYTES)
      throw new Error("Unity asset is too large");
    const unity = buildUnityDiff(before, after, selectedPatch);
    return unity.groups.length
      ? { unity }
      : { unityNotice: "No property changes in these hunks. Showing YAML." };
  } catch (error) {
    bb.log.debug(`Unity diff uses YAML for ${path}: ${String(error)}`);
    return { unityNotice: "Unity object view unavailable for this diff. Showing YAML." };
  }
}
