import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
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
    /**
     * At most `maxBytes` of a file's head, or null when it is missing. The
     * cache may hold more of it, from a wider read; this never returns more.
     */
    head(path: string, maxBytes: number): string | null {
      const text = read(path, maxBytes);
      if (text === null || text.length <= maxBytes / 4) return text;
      // At most maxBytes characters already cover maxBytes bytes.
      const bytes = Buffer.from(text.slice(0, maxBytes), "utf8");
      if (bytes.byteLength <= maxBytes) return text.slice(0, maxBytes);
      return completePrefix(bytes.subarray(0, maxBytes));
    },
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
