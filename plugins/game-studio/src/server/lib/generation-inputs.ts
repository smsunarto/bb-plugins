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
  const modelPath = source.kind === "model-edit" ? source.sourcePath : undefined;
  const allPaths = [...paths, ...(modelPath ? [modelPath] : [])];
  if (!allPaths.length) return prepared;
  const { inputs } = await bb.hosts
    .experimental_client({ contract: studioHostContract })
    .call(
      "captureCanvasInputs",
      { rootPath: game.rootPath, paths: [...new Set(allPaths)] },
      { hostId: game.hostId },
    );
  const snapshots = new Map(inputs.map(({ path, snapshot }) => [path, snapshot]));
  if (allPaths.some((path) => !snapshots.has(path)))
    throw new Error("The host did not capture every generation input. No request was submitted.");
  let request = snapshotRequest(source, snapshots);
  const model = inputs.find(({ path }) => path === modelPath);
  if (request.kind === "model-edit" && model) {
    const sameModel = request.sourceSha256 === model.sha256;
    if (request.sourceTaskId && !sameModel && ["apply-uv", "animate"].includes(request.operation))
      throw new Error(
        "The selected model bytes changed. Generate and select a new Tripo candidate or rig before continuing.",
      );
    request = { ...request, sourcePath: model.snapshot, sourceSha256: model.sha256 };
    // A locally edited GLB is a new upload, even when it overwrote a previously generated path.
    if (!sameModel) delete request.sourceTaskId;
  }
  return {
    ...prepared,
    request,
    target: {
      ...prepared.target,
      ...(paths.length
        ? {
            imageRevisions: inputs
              .filter(({ path }) => paths.includes(path))
              .map(({ path, sha256 }) => ({ path, sha256 })),
          }
        : {}),
      ...(model ? { modelRevision: { path: model.path, sha256: model.sha256 } } : {}),
    },
  };
}
