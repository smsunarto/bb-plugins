import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, sep } from "node:path";

/** Top-level folders inside the synced source tree (and every host mirror). */
export const SYNC_ROOTS = ["instructions", "rules", "skills", "conflicts"] as const;
export type SyncRoot = (typeof SYNC_ROOTS)[number];

/** Top-level folders always created when initializing a source tree or mirror. */
export const INIT_SYNC_ROOTS = ["instructions", "rules", "skills"] as const;

/** Maximum single file size synced across machines (matches the catalog tree budget). */
export const MAX_SYNC_FILE_BYTES = 5 * 1024 * 1024;
/** Maximum total files walked or synced in one tree. */
export const MAX_SYNC_FILES = 5_000;
/** Raw-byte target per host read RPC call (base64 expands by 4/3; daemon cap is 8 MiB). */
export const READ_BATCH_BYTES = 2 * 1024 * 1024;
/** Raw-byte target per host write RPC call (daemon input cap is 32 MiB). */
export const WRITE_BATCH_BYTES = 4 * 1024 * 1024;
/** Maximum length of one relative sync path in bytes. */
export const MAX_SYNC_PATH_BYTES = 512;

export type FileDigest = {
  sha256: string;
  executable: boolean;
  size: number;
};

export type SyncManifest = Record<string, FileDigest>;

export type WalkResult = {
  manifest: SyncManifest;
  symlinks: string[];
  tooLarge: string[];
  truncated: boolean;
};

export class SymlinkRefusedError extends Error {
  constructor(path: string) {
    super(`Refusing to follow symlink at ${path}`);
    this.name = "SymlinkRefusedError";
  }
}

const SYNC_ROOT_SET = new Set<string>(SYNC_ROOTS);
// eslint-disable-next-line no-control-regex -- intentionally rejects NUL and ASCII control chars
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Whether a single directory/file basename is transient editor or OS junk. */
export function isIgnoredEntryName(name: string): boolean {
  if (name === ".DS_Store" || name === ".git") return true;
  if (name.startsWith("._") || name.startsWith(".#") || name.startsWith(".sync-tmp-")) return true;
  if (name.endsWith(".swp") || name.endsWith(".swo") || name.endsWith("~") || name.endsWith(".tmp"))
    return true;
  return false;
}

/**
 * Validates a POSIX relative path inside the synced source tree.
 * Only paths under `instructions/`, `rules/`, `skills/`, or `conflicts/` are allowed.
 */
export function isSafeSyncPath(relPath: string): boolean {
  if (relPath.length === 0 || Buffer.byteLength(relPath, "utf8") > MAX_SYNC_PATH_BYTES)
    return false;
  if (relPath.includes("\\") || CONTROL_CHARS.test(relPath)) return false;
  if (relPath.startsWith("/") || relPath.endsWith("/")) return false;
  const segments = relPath.split("/");
  if (segments.length < 2) return false;
  if (!SYNC_ROOT_SET.has(segments[0]!)) return false;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
    if (isIgnoredEntryName(segment)) return false;
  }
  return true;
}

/** Safe lowercase slug derived from a host name or id, for conflict folder names. */
export function sanitizeSlug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleaned || "host";
}

/** Compact UTC timestamp `YYYYMMDD-HHmmss` for conflict copy paths. */
export function conflictTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** Where a host's conflicting copy of `relPath` is saved inside `source/conflicts/`. */
export function conflictPathFor(relPath: string, hostSlug: string, timestamp: string): string {
  const inner = relPath.startsWith("conflicts/") ? relPath.slice("conflicts/".length) : relPath;
  return `conflicts/${sanitizeSlug(hostSlug)}-${timestamp}/${inner}`;
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const isMissing = (error: unknown) => errorCode(error) === "ENOENT";

/**
 * Ensures `root` exists and verifies that no existing segment along `relPath`
 * is a symlink. Returns the resolved absolute target path confined inside `root`.
 */
export async function resolveSafeSyncPath(
  root: string,
  relPath: string,
  options: { createRoot?: boolean } = {},
): Promise<string> {
  if (!isSafeSyncPath(relPath)) throw new Error(`Invalid sync path: ${JSON.stringify(relPath)}`);
  if (options.createRoot) await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  const segments = relPath.split("/");
  let current = realRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) throw new SymlinkRefusedError(relPath);
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }
  const resolved = join(realRoot, ...segments);
  if (!resolved.startsWith(realRoot + sep))
    throw new Error(`Sync path escapes root: ${JSON.stringify(relPath)}`);
  return resolved;
}

/** Walks `root` across the synced folders without following symlinks. */
export async function walkSyncTree(root: string): Promise<WalkResult> {
  const manifest: SyncManifest = {};
  const symlinks: string[] = [];
  const tooLarge: string[] = [];
  let count = 0;
  let truncated = false;

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    if (isMissing(error)) return { manifest, symlinks, tooLarge, truncated };
    throw error;
  }

  async function walk(absDir: string, relPrefix: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      if (isIgnoredEntryName(entry.name)) continue;
      const rel = `${relPrefix}/${entry.name}`;
      const abs = join(absDir, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isSafeSyncPath(rel)) continue;
      let st;
      try {
        st = await lstat(abs);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (st.isSymbolicLink()) {
        symlinks.push(rel);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_SYNC_FILE_BYTES) {
        tooLarge.push(rel);
        continue;
      }
      if (count >= MAX_SYNC_FILES) {
        truncated = true;
        return;
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(abs);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (bytes.length > MAX_SYNC_FILE_BYTES) {
        tooLarge.push(rel);
        continue;
      }
      manifest[rel] = {
        sha256: sha256Bytes(bytes),
        executable: (st.mode & 0o111) !== 0,
        size: bytes.length,
      };
      count++;
    }
  }

  for (const top of SYNC_ROOTS) {
    const absTop = join(realRoot, top);
    let st;
    try {
      st = await lstat(absTop);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (st.isSymbolicLink()) {
      symlinks.push(top);
      continue;
    }
    if (st.isDirectory()) await walk(absTop, top);
  }

  return { manifest, symlinks, tooLarge, truncated };
}

/** Reads one synced file safely without following symlinks. Returns null when missing. */
export async function readSyncFile(
  root: string,
  relPath: string,
): Promise<{ bytes: Buffer; executable: boolean; sha256: string } | null> {
  let abs: string;
  try {
    abs = await resolveSafeSyncPath(root, relPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  let st;
  try {
    st = await lstat(abs);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (st.isSymbolicLink()) throw new SymlinkRefusedError(relPath);
  if (!st.isFile()) return null;
  if (st.size > MAX_SYNC_FILE_BYTES)
    throw new Error(`${relPath} exceeds the ${MAX_SYNC_FILE_BYTES}-byte sync limit`);
  const bytes = await readFile(abs);
  return {
    bytes,
    executable: (st.mode & 0o111) !== 0,
    sha256: sha256Bytes(bytes),
  };
}

/** Writes one synced file atomically via `tmpDir` + `rename`, refusing symlinks. */
export async function writeSyncFileAtomic(
  root: string,
  tmpDir: string,
  relPath: string,
  bytes: Uint8Array,
  executable: boolean,
): Promise<{ sha256: string; size: number }> {
  if (bytes.length > MAX_SYNC_FILE_BYTES)
    throw new Error(`${relPath} exceeds the ${MAX_SYNC_FILE_BYTES}-byte sync limit`);
  const abs = await resolveSafeSyncPath(root, relPath, { createRoot: true });
  const parent = dirname(abs);
  await mkdir(parent, { recursive: true });
  const realRoot = await realpath(root);
  const realParent = await realpath(parent);
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep))
    throw new Error(`Sync parent escapes root: ${JSON.stringify(relPath)}`);

  await mkdir(tmpDir, { recursive: true });
  const staged = join(tmpDir, `.sync-tmp-${randomBytes(6).toString("hex")}`);
  await writeFile(staged, bytes);
  try {
    await chmod(staged, executable ? 0o755 : 0o644);
    await rename(staged, abs);
  } catch (error) {
    await unlink(staged).catch(() => undefined);
    throw error;
  }
  return { sha256: sha256Bytes(bytes), size: bytes.length };
}

/** Deletes one synced file and prunes empty subdirectories below its top-level root. */
export async function deleteSyncFileAndPrune(root: string, relPath: string): Promise<boolean> {
  let abs: string;
  try {
    abs = await resolveSafeSyncPath(root, relPath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  let deleted = false;
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) throw new SymlinkRefusedError(relPath);
    if (st.isFile()) {
      await unlink(abs);
      deleted = true;
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  // Prune empty directories below the top-level root (`instructions/`, `rules/`, `skills/`, `conflicts/`).
  const realRoot = await realpath(root).catch(() => null);
  if (realRoot) {
    const topDir = join(realRoot, relPath.split("/")[0]!);
    let dir = dirname(abs);
    while (dir !== topDir && dir.startsWith(topDir + sep)) {
      try {
        await rmdir(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }
  return deleted;
}

/** Ensures the standard empty top-level folders exist in `root`. */
export async function ensureSourceFolders(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const name of INIT_SYNC_ROOTS) await mkdir(join(root, name), { recursive: true });
}

/** True when two file digests have identical content hash and executable bit. */
export function sameDigest(a: FileDigest | undefined, b: FileDigest | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.sha256 === b.sha256 && a.executable === b.executable;
}

/** True when two manifests have identical paths, hashes, and executable bits. */
export function sameManifest(a: SyncManifest, b: SyncManifest): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) if (!sameDigest(a[key], b[key])) return false;
  return true;
}
