import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  commentsFileSchema,
  emptyCommentsFile,
  type CommentOp,
  type CommentsFile,
} from "../shared/comments.ts";
import type { CanvasSource, CommentsSignal } from "../shared/document.ts";
import { commentsChannel } from "../shared/document.ts";
import { applyOp, UnknownThreadError } from "../shared/ops.ts";
import { locateSource, type FileLocation } from "./locate.ts";

export { applyOp } from "../shared/ops.ts";

// The only module that touches the sidecar beside a canvas.

export class CommentsError extends Error {
  override readonly name = "CommentsError";
}

export interface ReadComments {
  readonly file: CommentsFile;
  readonly sha256: string | null;
  readonly malformed: boolean;
  readonly sidecarPath: string;
}

const writeAttempts = 3;

export function sidecarPathOf(path: string): string {
  return `${path}.comments.json`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sidecarLocation(bb: BbPluginApi, source: CanvasSource): Promise<FileLocation> {
  const located = await locateSource(bb, source);
  if (!located.ok) throw new CommentsError(`${located.reason}: ${located.detail}`);
  return { ...located.location, path: sidecarPathOf(located.location.path) };
}

async function readAt(bb: BbPluginApi, location: FileLocation): Promise<ReadComments> {
  let raw: Awaited<ReturnType<typeof bb.sdk.files.read>>;
  try {
    raw = await bb.sdk.files.read(location);
  } catch (error) {
    const detail = messageOf(error);
    if (/ENOENT|no such file|not found|does not exist|ENOTDIR/i.test(detail)) {
      return {
        file: emptyCommentsFile,
        sha256: null,
        malformed: false,
        sidecarPath: location.path,
      };
    }
    throw new CommentsError(detail);
  }
  let parsed: unknown = null;
  try {
    parsed = raw.contentEncoding === "utf8" ? JSON.parse(raw.content) : null;
  } catch {
    parsed = null;
  }
  const validated = commentsFileSchema.safeParse(parsed);
  return validated.success
    ? { file: validated.data, sha256: raw.sha256, malformed: false, sidecarPath: location.path }
    : { file: emptyCommentsFile, sha256: raw.sha256, malformed: true, sidecarPath: location.path };
}

export async function readComments(bb: BbPluginApi, source: CanvasSource): Promise<ReadComments> {
  return readAt(bb, await sidecarLocation(bb, source));
}

// Best effort: filled by writes since the server started, thread-storage only.
const openCounts = new Map<string, Map<string, number>>();

function recordOpenCount(source: CanvasSource, sidecarPath: string, file: CommentsFile): void {
  if (source.kind !== "thread-storage") return;
  const canvasPath = sidecarPath.slice(0, -".comments.json".length);
  const perThread = openCounts.get(source.threadId) ?? new Map<string, number>();
  perThread.set(canvasPath, file.threads.filter((thread) => thread.resolvedAtMs === null).length);
  openCounts.set(source.threadId, perThread);
}

export function commentsInstructions(threadId: string): string | null {
  const lines = [...(openCounts.get(threadId) ?? [])]
    .filter(([, count]) => count > 0)
    .map(
      ([path, count]) =>
        `Open canvas comments: ${path} (${count}). Read them with \`bb canvas comments ${path}\`.`,
    );
  return lines.length === 0 ? null : lines.join("\n");
}

export function resetCommentsInstructions(): void {
  openCounts.clear();
}

export async function applyCommentOp(
  bb: BbPluginApi,
  source: CanvasSource,
  op: CommentOp,
): Promise<{ file: CommentsFile; sha256: string }> {
  const location = await sidecarLocation(bb, source);
  for (let attempt = 0; attempt < writeAttempts; attempt += 1) {
    const current = await readAt(bb, location);
    if (current.malformed) {
      throw new CommentsError(`${location.path} is not a valid comments file; fix or delete it`);
    }
    let next: CommentsFile;
    try {
      next = applyOp(current.file, op, Date.now());
    } catch (error) {
      if (error instanceof UnknownThreadError) throw new CommentsError(error.message);
      throw error;
    }
    if (next === current.file && current.sha256 !== null) {
      return { file: current.file, sha256: current.sha256 };
    }
    const result = await bb.sdk.files.write({
      ...location,
      content: `${JSON.stringify(next, null, 2)}\n`,
      contentEncoding: "utf8",
      createParents: true,
      expectedSha256: current.sha256,
    });
    if (result.outcome === "written") {
      const signal: CommentsSignal = { sidecarPath: location.path, sha256: result.sha256 };
      bb.realtime.publish(commentsChannel, signal);
      recordOpenCount(source, location.path, next);
      return { file: next, sha256: result.sha256 };
    }
  }
  throw new CommentsError(`${location.path} changed ${writeAttempts} times while saving; retry`);
}
