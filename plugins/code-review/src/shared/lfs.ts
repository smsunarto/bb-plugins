import type { LfsObject } from "./schema.ts";

/*
 * Git LFS stores a large file outside Git and commits a three-line pointer
 * in its place. Pointer text is repository content, so its oid is accepted
 * only as 64 hex digits before anything turns it into a path or a request.
 */

const VERSION = "version https://git-lfs.github.com/spec/v1";
const OID = /^oid sha256:([0-9a-f]{64})$/;
const SIZE = /^size (\d{1,15})$/;
/** The specification keeps a pointer under this size. */
export const MAX_POINTER_BYTES = 1024;

/** The object a pointer names, or null for any other text. */
export function parseLfsPointer(text: string): LfsObject | null {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines[0] !== VERSION) return null;
  let oid: string | undefined;
  let size: number | undefined;
  for (const line of lines.slice(1)) {
    oid ??= OID.exec(line)?.[1];
    const bytes = SIZE.exec(line)?.[1];
    if (bytes !== undefined) size ??= Number(bytes);
  }
  return oid !== undefined && size !== undefined ? { oid, size } : null;
}

/**
 * Both sides' pointers, read from a diff of the pointer file, which GitHub
 * and git both show. A hint only, for the header before the file is read:
 * a pure rename has no patch, and a file can move into or out of LFS.
 */
export function lfsFromPatch(patch: string | null): {
  base: LfsObject | null;
  head: LfsObject | null;
} | null {
  if (!patch?.includes(VERSION)) return null;
  const base: string[] = [];
  const head: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("\\")) continue;
    const text = line.slice(1);
    if (line.startsWith("-")) base.push(text);
    else if (line.startsWith("+")) head.push(text);
    else {
      base.push(text);
      head.push(text);
    }
  }
  const sides = { base: parseLfsPointer(base.join("\n")), head: parseLfsPointer(head.join("\n")) };
  return sides.base || sides.head ? sides : null;
}
