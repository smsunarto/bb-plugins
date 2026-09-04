import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CanvasSource, UnreadableReason } from "../shared/document.ts";
import { locateSource } from "./locate.ts";
import { maxCanvasBytes } from "./parse.ts";

export interface CanvasFile {
  readonly content: string;
  readonly sha256: string;
  readonly modifiedAtMs: number | null;
}

export type ReadResult =
  | { readonly ok: true; readonly file: CanvasFile }
  | { readonly ok: false; readonly reason: UnreadableReason; readonly detail: string };

function classifyReadError(error: unknown): ReadResult {
  const detail = error instanceof Error ? error.message : String(error);
  if (/ENOENT|no such file|not found|does not exist|ENOTDIR/i.test(detail)) {
    return { ok: false, reason: "missing", detail };
  }
  if (/too large|exceeds|size limit/i.test(detail)) {
    return { ok: false, reason: "too-large", detail };
  }
  return { ok: false, reason: "host-offline", detail };
}

export async function readCanvasFile(bb: BbPluginApi, source: CanvasSource): Promise<ReadResult> {
  const located = await locateSource(bb, source);
  if (!located.ok) return { ok: false, reason: located.reason, detail: located.detail };
  let file: Awaited<ReturnType<typeof bb.sdk.files.read>>;
  try {
    file = await bb.sdk.files.read(located.location);
  } catch (error) {
    return classifyReadError(error);
  }
  if (file.contentEncoding !== "utf8") {
    return { ok: false, reason: "binary", detail: "the file is not UTF-8 text" };
  }
  if (file.content.length > maxCanvasBytes) {
    return {
      ok: false,
      reason: "too-large",
      detail: `the file is ${file.content.length} bytes; the limit is ${maxCanvasBytes}`,
    };
  }
  return {
    ok: true,
    file: { content: file.content, sha256: file.sha256, modifiedAtMs: file.modifiedAtMs ?? null },
  };
}
