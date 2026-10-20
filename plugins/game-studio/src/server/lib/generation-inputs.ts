import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { generationImagePaths } from "../../shared/generation.ts";
import type { GenerationJob, MediaRequest } from "../../shared/generation.ts";
import type { Game } from "../../shared/schema.ts";
import { studioHostContract } from "../../shared/host-contract.ts";

type Prepared = { request: MediaRequest; target: NonNullable<GenerationJob["target"]> };

function snapshotRequest(source: MediaRequest, snapshots: Map<string, string>): MediaRequest {
  const snapshot = (path: string) => snapshots.get(path)!;
  if (source.kind === "image" || source.kind === "text" || source.kind === "agent")
    return { ...source, images: source.images.map(snapshot) };
  if (source.kind === "model-edit")
    return source.views
      ? {
          ...source,
          views: Object.fromEntries(
            Object.entries(source.views).map(([view, path]) => [view, snapshot(path)]),
          ),
        }
      : source;
  if (source.kind === "video")
    return {
      ...source,
      ...(source.imagePath ? { imagePath: snapshots.get(source.imagePath)! } : {}),
      ...(source.endImagePath ? { endImagePath: snapshots.get(source.endImagePath)! } : {}),
    };
  return {
    ...source,
    approvedImagePath: snapshots.get(source.approvedImagePath)!,
    ...(source.views
      ? {
          views: Object.fromEntries(
            Object.entries(source.views).map(([view, path]) => [view, snapshots.get(path!)!]),
          ),
        }
      : {}),
  };
}

/**
 * Freeze the selected image bytes before dispatch while retaining their source revisions. The
 * host copies each image beside the project, so its bytes never cross to the server and back.
 */
export async function captureCanvasInputs(bb: BbPluginApi, game: Game, prepared: Prepared) {
  const source = prepared.request;
  const paths = generationImagePaths(source);
  if (!paths.length) return prepared;
  const { inputs } = await bb.hosts
    .experimental_client({ contract: studioHostContract })
    .call(
      "captureCanvasInputs",
      { rootPath: game.rootPath, paths: [...new Set(paths)] },
      { hostId: game.hostId },
    );
  const snapshots = new Map(inputs.map(({ path, snapshot }) => [path, snapshot]));
  if (paths.some((path) => !snapshots.has(path)))
    throw new Error("The host did not capture every generation input. No request was submitted.");
  return {
    ...prepared,
    request: snapshotRequest(source, snapshots),
    target: {
      ...prepared.target,
      imageRevisions: inputs.map(({ path, sha256 }) => ({ path, sha256 })),
    },
  };
}
