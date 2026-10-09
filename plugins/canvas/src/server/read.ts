import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CanvasSource, UnreadableReason } from "../shared/document.ts";
import { locateSource } from "./locate.ts";
import { pollRead } from "./lib/poll-read.ts";
import { maxCanvasBytes } from "../shared/parse.ts";

export interface CanvasFile {
  readonly content: string;
  readonly sha256: string;
  readonly modifiedAtMs: number | null;
}

// `unchanged` and `unreadable` match the file and render outputs as they are.
export type ReadResult =
  | { readonly status: "read"; readonly file: CanvasFile }
  | { readonly status: "unchanged"; readonly sha256: string }
  | { readonly status: "unreadable"; readonly reason: UnreadableReason; readonly detail: string };

function classifyReadError(error: unknown): ReadResult {
  const detail = error instanceof Error ? error.message : String(error);
  if (/ENOENT|no such file|not found|does not exist|ENOTDIR/i.test(detail)) {
    return { status: "unreadable", reason: "missing", detail };
  }
  if (/too large|exceeds|size limit/i.test(detail)) {
    return { status: "unreadable", reason: "too-large", detail };
  }
  return { status: "unreadable", reason: "host-offline", detail };
}

/** The canvas, or `unchanged` while it is still the version with `knownSha256`. */
export async function readCanvasFile(
  bb: BbPluginApi,
  source: CanvasSource,
  knownSha256: string | null,
): Promise<ReadResult> {
  const located = await locateSource(bb, source);
  if (!located.ok) {
    return { status: "unreadable", reason: located.reason, detail: located.detail };
  }
  let file: Awaited<ReturnType<typeof pollRead>>;
  try {
    file = await pollRead(bb, located.location, knownSha256);
  } catch (error) {
    return classifyReadError(error);
  }
  if ("unchanged" in file) return { status: "unchanged", sha256: file.unchanged };
  if (file.contentEncoding !== "utf8") {
    return { status: "unreadable", reason: "binary", detail: "the file is not UTF-8 text" };
  }
  if (file.content.length > maxCanvasBytes) {
    return {
      status: "unreadable",
      reason: "too-large",
      detail: `the file is ${file.content.length} bytes; the limit is ${maxCanvasBytes}`,
    };
  }
  if (file.sha256 === knownSha256) return { status: "unchanged", sha256: file.sha256 };
  return {
    status: "read",
    file: { content: file.content, sha256: file.sha256, modifiedAtMs: file.modifiedAtMs ?? null },
  };
}
