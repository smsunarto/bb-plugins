import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Game } from "../../shared/schema.ts";
import { modelEvidenceInput, type ModelEvidenceInput } from "../../shared/model-review.ts";
import { evidenceManifestSchema, getGame, readOptional } from "./studio.ts";
import { fileArgs as mediaFileArgs, withMedia } from "./media.ts";
import { projectFile, relativeFile } from "./paths.ts";

type Run = { id: string; capturedAtMs: number; scene?: string; files: string[] };
type Manifest = { version: 1; runs: unknown[] } & Record<string, unknown>;
/** Checks the manifest as the Evidence tab reads it, then appends to the raw JSON so fields
 * from other writers survive. */
export function appendEvidence(manifest: unknown, run: Run): Manifest {
  const current = evidenceManifestSchema.parse(manifest);
  if (new Set(current.runs.map((item) => item.id)).size !== current.runs.length)
    throw new Error("Evidence manifest contains duplicate run IDs");
  const previous = current.runs.find((item) => item.id === run.id);
  if (previous) {
    if (JSON.stringify(previous.files) !== JSON.stringify(run.files))
      throw new Error("Evidence run ID already exists with different captures");
    return manifest as Manifest;
  }
  const next = { ...(manifest as Manifest), runs: [...(manifest as Manifest).runs, run] };
  evidenceManifestSchema.parse(next);
  return next;
}
function validateCapture(content: string, name: string) {
  const bytes = Buffer.from(content, "base64");
  if (!bytes.length || bytes.length > 25 * 1024 * 1024 || bytes.toString("base64") !== content)
    throw new Error("Capture must be canonical base64, up to 25 MiB");
  if (
    name.endsWith(".png")
      ? bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
      : bytes.subarray(4, 8).toString() !== "ftyp"
  )
    throw new Error("Capture does not match its PNG/MP4 extension");
}
export async function saveModelEvidence(bb: BbPluginApi, input: ModelEvidenceInput) {
  const parsed = modelEvidenceInput.parse(input);
  const game = await withMedia(bb, await getGame(bb, parsed.gameId));
  const fileArgs = (path: string) => mediaFileArgs(game, path);
  const prefix = `canvas/evidence/${parsed.runId}`;
  if (parsed.action === "file") {
    validateCapture(parsed.content, parsed.name);
    const path = `${prefix}/${parsed.name}`;
    const written = await bb.sdk.files.write({
      ...fileArgs(path),
      content: parsed.content,
      contentEncoding: "base64",
      expectedSha256: null,
      createParents: true,
    });
    if (written.outcome !== "written")
      throw new Error("Capture path already exists; use a fresh run ID");
    return { runId: parsed.runId, files: [path] };
  }
  const model = relativeFile(parsed.model);
  if (!/\.(glb|gltf)$/i.test(model)) throw new Error("Evidence source must be a GLB or glTF");
  const source = await bb.sdk.files.read(fileArgs(model));
  if (source.sha256 !== parsed.modelSha256)
    throw new Error(
      "Model changed since it was loaded. Reload the viewer before recording evidence.",
    );
  const paths = parsed.script.shots.map(
    (shot) => `${prefix}/${shot.name}.${shot.video ? "mp4" : "png"}`,
  );
  for (const path of paths) await bb.sdk.files.read(fileArgs(path));
  const metadata = JSON.stringify(
    { model, modelSha256: source.sha256, script: parsed.script },
    null,
    2,
  );
  const provenance = await bb.sdk.files.write({
    ...fileArgs(`${prefix}/shots.json`),
    content: metadata,
    contentEncoding: "utf8",
    expectedSha256: null,
    createParents: true,
  });
  if (provenance.outcome !== "written") {
    const existing = await bb.sdk.files.read(fileArgs(`${prefix}/shots.json`));
    if (existing.content !== metadata) throw new Error("Run already has a different shot script");
  }
  const run = {
    id: parsed.runId,
    capturedAtMs: Date.now(),
    scene: `Model review: ${model}`.slice(0, 200),
    files: paths,
  };
  await publishEvidence(bb, game, run);
  return { runId: run.id, files: paths };
}

async function publishEvidence(bb: BbPluginApi, game: Game, run: Run) {
  const path = "canvas/evidence/index.json";
  for (let attempt = 0; attempt < 5; attempt++) {
    const file = await readOptional(bb, game, path);
    if (file && file.contentEncoding !== "utf8") throw new Error("Evidence manifest must be UTF-8");
    const next = appendEvidence(file ? JSON.parse(file.content) : { version: 1, runs: [] }, run);
    const result = await bb.sdk.files.write({
      hostId: game.hostId,
      rootPath: game.rootPath,
      path: projectFile(game.rootPath, path),
      content: `${JSON.stringify(next, null, 2)}\n`,
      contentEncoding: "utf8",
      expectedSha256: file?.sha256 ?? null,
      createParents: true,
    });
    if (result.outcome === "written") return;
  }
  throw new Error("Evidence kept changing while this run was saved. Run the capture again.");
}
