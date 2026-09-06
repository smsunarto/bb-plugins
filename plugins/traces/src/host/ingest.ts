import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

export const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
export const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export type SourceLine = {
  line: number;
  offset: number;
  length: number;
  hash: string;
  bytes: Buffer | null;
};

/** The complete newline is part of the span. An incomplete tail is never committed. */
export async function* readLines(
  path: string,
  offset: number,
  line: number,
  size: number,
  signal?: AbortSignal,
): AsyncGenerator<SourceLine> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let position = offset;
  let lineStart = offset;
  let length = 0;
  let pieces: Buffer[] = [];
  let digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  try {
    while (position < size) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position,
      );
      if (!bytesRead) break;
      let start = 0;
      while (start < bytesRead) {
        const newline = buffer.subarray(0, bytesRead).indexOf(10, start);
        const end = newline !== -1 ? newline + 1 : bytesRead;
        const piece = buffer.subarray(start, end);
        digest.update(piece);
        length += piece.length;
        if (length <= MAX_RECORD_BYTES) pieces.push(Buffer.from(piece));
        else pieces = [];
        if (newline !== -1) {
          line += 1;
          yield {
            line,
            offset: lineStart,
            length,
            hash: digest.digest("hex"),
            bytes: length <= MAX_RECORD_BYTES ? Buffer.concat(pieces, length) : null,
          };
          lineStart += length;
          length = 0;
          pieces = [];
          digest = createHash("sha256");
        }
        start = end;
      }
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
}

/** Discovery never follows symlinks. A failed traversal must not mark unseen files missing. */
export async function* discover(
  root: string,
  signal: AbortSignal | undefined,
  accepts: (path: string) => boolean,
): AsyncGenerator<string> {
  signal?.throwIfAborted();
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error("Source must not be a symlink.");
  if (info.isFile()) {
    if (!accepts(root)) throw new Error("Source file is not supported by the selected provider.");
    yield root;
    return;
  }
  if (!info.isDirectory()) throw new Error("Source must be a directory or a supported JSONL file.");
  for await (const path of discoverDirectory(root, signal)) {
    if (accepts(path)) yield path;
  }
}

export async function sourceWatchPath(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("Source must not be a symlink.");
  return info.isFile() ? dirname(path) : path;
}

async function* discoverDirectory(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  const queue = [root];
  let discovered = 0;
  while (queue.length) {
    signal?.throwIfAborted();
    const directory = queue.pop();
    if (!directory) continue;
    const handle = await opendir(directory);
    for await (const entry of handle) {
      signal?.throwIfAborted();
      discovered += 1;
      if (discovered > 1_000_000 || queue.length > 100_000) {
        throw new Error(
          "Source discovery exceeded its directory budget. Configure a narrower root.",
        );
      }
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) yield path;
    }
  }
}

export async function probes(path: string, offset: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const length = Math.min(offset, 4096);
    const head = Buffer.alloc(length);
    const tail = Buffer.alloc(length);
    const first = await file.read(head, 0, length, 0);
    const last = await file.read(tail, 0, length, offset - length);
    return hash(
      Buffer.concat([head.subarray(0, first.bytesRead), tail.subarray(0, last.bytesRead)]),
    );
  } finally {
    await file.close();
  }
}

export type VerifiedSpan = {
  state: "available" | "missing" | "changed" | "unreadable";
  bytes: Buffer;
  message: string | null;
};

const verified = new Map<string, { stamp: string; expires: number }>();
const fileStamp = (info: Stats): string =>
  [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
const changedSpan = (): VerifiedSpan => ({
  state: "changed",
  bytes: Buffer.alloc(0),
  message: "Source bytes changed after indexing. Refresh the index.",
});

async function readSpanPage(
  file: FileHandle,
  span: { offset: number; length: number; hash: string },
  offset: number,
  limit: number,
  verify: boolean,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; valid: boolean }> {
  const digest = verify ? createHash("sha256") : null;
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const output: Buffer[] = [];
  const endPosition = verify ? span.length : Math.min(span.length, offset + limit);
  let position = verify ? 0 : offset;
  while (position < endPosition) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, endPosition - position),
      span.offset + position,
    );
    if (!bytesRead) break;
    digest?.update(buffer.subarray(0, bytesRead));
    const start = Math.max(offset - position, 0);
    const end = Math.min(offset + limit - position, bytesRead);
    if (end > start) output.push(Buffer.from(buffer.subarray(start, end)));
    position += bytesRead;
  }
  return {
    bytes: Buffer.concat(output),
    valid: position === endPosition && (!digest || digest.digest("hex") === span.hash),
  };
}

/** Cached hashes are valid only for an unchanged file identity and a short paging window. */
export async function readVerifiedSpan(
  path: string,
  span: { offset: number; length: number; hash: string },
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<VerifiedSpan> {
  const key = `${path}\0${span.offset}:${span.length}:${span.hash}`;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (before.size < span.offset + span.length) return changedSpan();
      const stamp = fileStamp(before);
      const cache = verified.get(key);
      const cached = limit > 0 && cache?.stamp === stamp && cache.expires > Date.now();
      const page = await readSpanPage(file, span, offset, limit, !cached, signal);
      const after = await file.stat();
      const current = await lstat(path);
      if (
        !page.valid ||
        fileStamp(after) !== stamp ||
        fileStamp(current) !== stamp ||
        !current.isFile()
      ) {
        verified.delete(key);
        return changedSpan();
      }
      verified.delete(key);
      verified.set(key, { stamp, expires: cached ? cache.expires : Date.now() + 5000 });
      if (verified.size > 64) verified.delete(verified.keys().next().value!);
      return { state: "available", bytes: page.bytes, message: null };
    } finally {
      await file.close();
    }
  } catch (error) {
    verified.delete(key);
    signal?.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    return {
      state: code === "ENOENT" ? "missing" : "unreadable",
      bytes: Buffer.alloc(0),
      message:
        code === "ENOENT"
          ? "The source file no longer exists."
          : "The source file could not be read.",
    };
  }
}
