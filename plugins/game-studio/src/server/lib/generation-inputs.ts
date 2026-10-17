import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { generationImagePaths } from "../../shared/generation.ts";
import type { GenerationJob, MediaRequest } from "../../shared/generation.ts";
import type { Game } from "../../shared/schema.ts";
import { projectFile } from "./paths.ts";

type Prepared = { request: MediaRequest; target: NonNullable<GenerationJob["target"]> };

function snapshotRequest(source: MediaRequest, snapshots: Map<string, string>): MediaRequest {
  if (source.kind === "image" || source.kind === "text")
    return { ...source, images: source.images.map((path) => snapshots.get(path)!) };
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

/** Freeze the selected image bytes before dispatch while retaining their source revisions. */
export async function captureCanvasInputs(bb: BbPluginApi, game: Game, prepared: Prepared) {
  const source = prepared.request;
  const paths = generationImagePaths(source);
  if (!paths.length) return prepared;
  const snapshots = new Map<string, string>();
  const written = new Set<string>();
  const imageRevisions: { path: string; sha256: string }[] = [];
  for (const path of new Set(paths)) {
    const file = await bb.sdk.files.read({
      hostId: game.hostId,
      rootPath: game.rootPath,
      path: projectFile(game.rootPath, path),
    });
    const extension = /\.(png|jpe?g|webp)$/i.exec(path)?.[1]?.toLowerCase();
    if (
      !extension ||
      file.contentEncoding !== "base64" ||
      file.sizeBytes > 14 * 1024 * 1024 ||
      Buffer.byteLength(file.content, "base64") > 14 * 1024 * 1024
    )
      throw new Error("Generation image inputs must be PNG, JPEG or WebP files under 14 MiB.");
    const snapshot = `canvas/inputs/${file.sha256}.${extension === "jpeg" ? "jpg" : extension}`;
    if (!written.has(snapshot)) {
      const location = {
        hostId: game.hostId,
        rootPath: game.rootPath,
        path: projectFile(game.rootPath, snapshot),
      };
      const result = await bb.sdk.files.write({
        ...location,
        content: file.content,
        contentEncoding: "base64",
        expectedSha256: null,
        createParents: true,
      });
      if (result.outcome === "conflict") {
        const existing = await bb.sdk.files.read(location);
        if (existing.sha256 !== file.sha256)
          throw new Error("A saved generation input changed. No request was submitted.");
      }
      written.add(snapshot);
    }
    snapshots.set(path, snapshot);
    imageRevisions.push({ path, sha256: file.sha256 });
  }
  return {
    ...prepared,
    request: snapshotRequest(source, snapshots),
    target: { ...prepared.target, imageRevisions },
  };
}
