import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * The Drive is the Captain thread's own thread storage. Every Captain runs on
 * the bb server's machine, so the Drive is local disk to this plugin server,
 * and `configure`, which is synchronous, has to read it with `node:fs`.
 * Reads and writes share this one module so the cache stays coherent.
 */

export const DRIVE_FILES = ["CAPTAIN.md", "CREW.md", "NOTES.md"] as const;
/** A Drive read or write larger than this is refused rather than streamed. */
export const DRIVE_FILE_MAX_BYTES = 4 * 1024 * 1024;
const SKILLS_INDEX_MAX = 50;

export class DrivePathError extends Error {}

/**
 * Resolve a Drive-relative path, refusing anything that could leave the Drive:
 * an absolute path, a `..` segment, a backslash or NUL, or a symlink inside the
 * Drive that points outside it.
 */
export function resolveDrivePath(driveDir: string, path: string): string {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed.length > 512) {
    throw new DrivePathError("a Drive path is 1 to 512 characters");
  }
  if (isAbsolute(trimmed) || /[\\\0]/u.test(trimmed)) {
    throw new DrivePathError(`not a Drive-relative path: ${trimmed}`);
  }
  const segments = trimmed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    throw new DrivePathError(`a Drive path cannot leave the Drive: ${trimmed}`);
  }
  const resolved = join(driveDir, ...segments);
  if (!isInside(realExisting(driveDir), realExisting(resolved))) {
    throw new DrivePathError(`a Drive path cannot leave the Drive: ${trimmed}`);
  }
  return resolved;
}

/** The one Drive folder crew may write. The rest, the Captain's rules files included, is the Captain's. */
export const CREW_DRIVE_DIR = "crew";

/**
 * Whether a path `resolveDrivePath` returned lies in the Drive's crew folder by
 * its real path, so a symlink in the folder, or the folder itself as one,
 * cannot point a crew write at the Captain's files.
 */
export function inCrewDir(driveDir: string, resolved: string): boolean {
  return isInside(join(realExisting(driveDir), CREW_DRIVE_DIR), realExisting(resolved));
}

/** The nearest existing ancestor's real path, with the missing tail re-appended. */
function realExisting(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(basename(current));
      current = parent;
    }
  }
}

export function isInside(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside !== "" && !inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside);
}

/** `cap` is the byte limit the text was read with; a hit needs the whole file or at least the cap asked for. */
type Cached = { ino: bigint; size: bigint; mtimeNs: bigint; cap: number; text: string };

export type Drive = ReturnType<typeof createDrive>;

export function createDrive() {
  const cache = new Map<string, Cached>();

  /**
   * Read a file, at most `maxBytes` of it, or null when it is missing. Served
   * from memory while the file's inode, size and mtime are unchanged, so a
   * Captain's direct edit to `CAPTAIN.md` is seen on the next session build.
   */
  function read(path: string, maxBytes = DRIVE_FILE_MAX_BYTES): string | null {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) {
      cache.delete(path);
      return null;
    }
    const cached = cache.get(path);
    if (
      cached !== undefined &&
      cached.ino === stat.ino &&
      cached.size === stat.size &&
      cached.mtimeNs === stat.mtimeNs &&
      (cached.cap >= maxBytes || BigInt(cached.cap) >= stat.size)
    ) {
      return cached.text;
    }
    const text = readHead(path, Math.min(Number(stat.size), maxBytes), stat.size > maxBytes);
    cache.set(path, { ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, cap: maxBytes, text });
    return text;
  }

  return {
    read,
    /** Size in bytes, or null when missing. */
    size(path: string): number | null {
      const stat = statSync(path, { throwIfNoEntry: false });
      return stat?.isFile() === true ? stat.size : null;
    },
    /**
     * Write a file atomically, or with `createOnly` only when it is missing, so
     * a retry never clobbers what the Captain wrote meanwhile.
     */
    write(
      path: string,
      content: string,
      options: { createOnly?: boolean } = {},
    ): "written" | "kept" {
      mkdirSync(dirname(path), { recursive: true });
      if (options.createOnly === true) {
        try {
          writeFileSync(path, content, { flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return "kept";
          throw error;
        }
      } else {
        const temp = join(
          dirname(path),
          `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
        );
        try {
          writeFileSync(temp, content);
          renameSync(temp, path);
        } catch (error) {
          rmSync(temp, { force: true });
          throw error;
        }
      }
      cache.delete(path);
      read(path);
      return "written";
    },
    /** Files under the Drive's `skills/`, as Drive-relative paths, sorted and capped. */
    skillsIndex(driveDir: string): string[] {
      const root = join(driveDir, "skills");
      let entries;
      try {
        entries = readdirSync(root, { recursive: true, withFileTypes: true });
      } catch {
        return [];
      }
      return entries
        .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
        .map((entry) => relative(driveDir, join(entry.parentPath, entry.name)).split(sep).join("/"))
        .sort()
        .slice(0, SKILLS_INDEX_MAX);
    },
  };
}

/**
 * At most `maxBytes` of a regular file's head, or null when the file is gone,
 * is not a regular file, or is not inside `root` (a real path). The checks and
 * the read use one descriptor: opened without following a final link (and
 * without blocking on a FIFO), checked by `fstat`, located through
 * `/proc/self/fd`, then read. A path swapped after the open cannot change what
 * is read. Where `/proc` is missing (macOS), the location is the path's own
 * real path, accepted only while it is still the same file as the descriptor:
 * a narrower race, not none.
 */
export function readInside(root: string, path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const located = locate(fd, path, stat);
    if (located === null || !isInside(root, located)) return null;
    const length = readInto(fd, Buffer.alloc(Math.min(stat.size, maxBytes)));
    return stat.size > maxBytes ? completePrefix(length) : length.toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Where an open file is: the kernel's own path for it, or the path's real path while it is the same file. */
function locate(fd: number, path: string, stat: Stats): string | null {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    // No /proc: fall through.
  }
  const real = realpathSync(path);
  const now = lstatSync(real, { throwIfNoEntry: false });
  return now !== undefined && now.dev === stat.dev && now.ino === stat.ino ? real : null;
}

/** Fills `buffer` from the descriptor's start, or as much as the file holds. */
function readInto(fd: number, buffer: Buffer): Buffer {
  let length = 0;
  while (length < buffer.byteLength) {
    const read = readSync(fd, buffer, length, buffer.byteLength - length, length);
    if (read === 0) break;
    length += read;
  }
  return buffer.subarray(0, length);
}

/**
 * The characters wholly inside `bytes`: a character the cut split in two is
 * left out, rather than decoded as U+FFFD.
 */
function completePrefix(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes, { stream: true });
}

/** A file's first `maxBytes`; `cut` when the file is longer, so its last character may be split. */
function readHead(path: string, maxBytes: number, cut = false): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    let length = 0;
    while (length < maxBytes) {
      const read = readSync(fd, buffer, length, maxBytes - length, null);
      if (read === 0) break;
      length += read;
    }
    const head = buffer.subarray(0, length);
    return cut ? completePrefix(head) : head.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
