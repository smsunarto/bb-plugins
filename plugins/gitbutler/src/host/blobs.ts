import { randomUUID } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import { lstat, mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { LFS_DOWNLOAD_MS } from "../shared/host-contract.ts";
import type { BlobDescriptor, BlobObject } from "../shared/schema.ts";
import { ButFailedError, pipeGit, runGit, runGitCommand } from "./cli.ts";
import { remember, share } from "./repository-state.ts";

/*
 * Whole files at a commit, for another plugin's preview of a branch: an
 * image, a model, a Unity asset. A descriptor says what a path holds without
 * reading it whole; chunks then read the content a range at a time, since a
 * host call's result is capped well below a large asset. Git LFS pointers are
 * read through to their objects, fetched into the checkout's own LFS store.
 */

/** No preview reads a file larger than this. */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
/** Fits one chunk's base64 under the host's 8 MiB result cap. */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
/** Git LFS specifies that a pointer file is smaller than this. */
const MAX_POINTER_BYTES = 1024;
/** Materialized blobs older than this are swept on the next write. */
const SPOOL_TTL_MS = 15 * 60_000;
/** A worker that ended without removing its spool, as a killed one does, left it this long ago. */
const ABANDONED_MS = 24 * 60 * 60_000;
const SPOOL_PREFIX = "bb-gitbutler-blobs-";

/**
 * This worker's own spool, made on first use. `mkdtemp` creates it readable
 * by this user alone and under a fresh name, so on a shared machine another
 * user can neither read a private repository's files there nor plant any.
 */
let spool: Promise<string> | null = null;
function spoolDirectory(): Promise<string> {
  spool ??= mkdtemp(join(tmpdir(), SPOOL_PREFIX)).then(
    (directory) => {
      process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
      void sweepAbandoned(directory);
      return directory;
    },
    (error: unknown) => {
      spool = null;
      throw error;
    },
  );
  return spool;
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const LFS_OID = /^[0-9a-f]{64}$/;

/**
 * A Git LFS pointer, or null for anything else. Strict: the oid becomes a
 * path in the LFS store, so only 64 hex digits are accepted.
 */
export function parseLfsPointer(text: string): { oid: string; size: number } | null {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines[0] !== "version https://git-lfs.github.com/spec/v1") return null;
  const oid = lines.find((line) => line.startsWith("oid sha256:"))?.slice("oid sha256:".length);
  const size = lines.find((line) => line.startsWith("size "))?.slice("size ".length);
  if (!oid || !LFS_OID.test(oid) || !size || !/^\d{1,15}$/.test(size)) return null;
  return { oid, size: Number(size) };
}

/** A repository-relative path git can name. Never absolute, never above the root. */
function assertRepositoryPath(path: string): void {
  if (
    path === "" ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new ButFailedError("That is not a file path in the repository.");
  }
}

/** What `path` holds at `rev`, without reading a large file. */
export async function describeBlob(
  repository: string,
  rev: string,
  path: string,
  signal: AbortSignal,
): Promise<BlobDescriptor> {
  assertRepositoryPath(path);
  const listed = await runGitCommand(
    repository,
    ["--literal-pathspecs", "ls-tree", "-l", "-z", "--full-tree", rev, "--", path],
    signal,
  );
  if (listed.code !== 0) {
    throw new ButFailedError(listed.stderr.split("\n")[0]?.trim() || "git ls-tree failed.");
  }
  const entry = listed.stdout
    .split("\0")
    .map((line) => /^(\d{6}) (\w+) ([0-9a-f]+) +(-|\d+)\t([\s\S]*)$/.exec(line))
    .find((match) => match?.[5] === path);
  if (!entry) return { kind: "missing" };
  const [, mode, type, oid, size] = entry as unknown as [string, string, string, string, string];
  if (type === "commit") return { kind: "submodule", oid };
  if (type !== "blob") return { kind: "missing" };
  if (mode === "120000") {
    const target = await runGit(repository, ["cat-file", "blob", oid], signal);
    return { kind: "symlink", target: target.slice(0, 4096) };
  }
  const bytes = Number(size);
  let lfs: { oid: string; size: number; local: boolean } | null = null;
  if (bytes < MAX_POINTER_BYTES) {
    const pointer = parseLfsPointer(await runGit(repository, ["cat-file", "blob", oid], signal));
    if (pointer)
      lfs = { ...pointer, local: (await storedObject(repository, pointer, signal)) !== null };
  }
  return { kind: "blob", oid, size: bytes, lfs };
}

/** The checkout's LFS store: `git lfs env` knows a configured one, else Git's default. */
function mediaDirectory(repository: string, signal: AbortSignal): Promise<string> {
  return remember(`lfs-media\0${repository}`, signal, async (shared) => {
    const env = await runGitCommand(repository, ["lfs", "env"], shared).catch(() => null);
    const configured = env?.code === 0 ? /^LocalMediaDir=(.+)$/m.exec(env.stdout)?.[1]?.trim() : "";
    if (configured && isAbsolute(configured)) return configured;
    const common = (await runGit(repository, ["rev-parse", "--git-common-dir"], shared)).trim();
    return resolve(repository, common, "lfs", "objects");
  });
}

/** The LFS object's file in the store, when it is there in full. */
async function storedObject(
  repository: string,
  pointer: { oid: string; size: number },
  signal: AbortSignal,
): Promise<string | null> {
  if (!LFS_OID.test(pointer.oid)) throw new ButFailedError("That is not a Git LFS object id.");
  const store = await mediaDirectory(repository, signal);
  const file = resolve(store, pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
  const inside = relative(store, file);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new ButFailedError("That Git LFS object is outside the store.");
  }
  const found = await stat(file).catch(() => null);
  return found?.isFile() && found.size === pointer.size ? file : null;
}

/**
 * Download an LFS object into the checkout's store with the checkout's own
 * endpoint and credentials. Smudge downloads what it is handed, unless the
 * checkout skips smudging or excludes the path, so this run overrides both,
 * and the store is checked afterwards rather than trusted.
 */
async function fetchObject(
  repository: string,
  pointer: { oid: string; size: number },
  signal: AbortSignal,
): Promise<string> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(LFS_DOWNLOAD_MS)]);
  const text = `version https://git-lfs.github.com/spec/v1\noid sha256:${pointer.oid}\nsize ${pointer.size}\n`;
  try {
    await pipeGit(
      repository,
      ["-c", "lfs.fetchinclude=", "-c", "lfs.fetchexclude=", "lfs", "smudge"],
      deadline,
      { input: text, env: { GIT_LFS_SKIP_SMUDGE: "0", GCM_INTERACTIVE: "never" } },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    if (deadline.aborted) throw new ButFailedError("Git LFS took too long to download the file.");
    const message = error instanceof Error ? error.message : String(error);
    throw new ButFailedError(
      /'lfs' is not a git command/i.test(message)
        ? "Git LFS is not installed on this machine."
        : `Git LFS could not download the file: ${message}`,
    );
  }
  const file = await storedObject(repository, pointer, signal);
  if (!file) throw new ButFailedError("Git LFS did not download the file.");
  return file;
}

/** This user's spools that no worker has written to for a day. */
async function sweepAbandoned(own: string): Promise<void> {
  const root = tmpdir();
  const uid = process.getuid?.();
  const names = await readdir(root).catch(() => []);
  await Promise.all(
    names
      .filter((name) => name.startsWith(SPOOL_PREFIX))
      .map(async (name) => {
        const directory = join(root, name);
        if (directory === own) return;
        const found = await lstat(directory).catch(() => null);
        if (!found?.isDirectory() || (uid !== undefined && found.uid !== uid)) return;
        if (Date.now() - found.mtimeMs < ABANDONED_MS) return;
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }),
  );
}

/** Old spooled blobs go, so the spool holds only what previews are reading. */
async function sweepSpool(directory: string): Promise<void> {
  const now = Date.now();
  const names = await readdir(directory).catch(() => []);
  await Promise.all(
    names.map(async (name) => {
      const file = join(directory, name);
      const found = await stat(file).catch(() => null);
      if (found && now - found.mtimeMs > SPOOL_TTL_MS) await rm(file, { force: true });
    }),
  );
}

/** A Git blob written out once, so each chunk reads a range instead of the whole blob again. */
function spooledBlob(repository: string, oid: string, signal: AbortSignal): Promise<string> {
  return share(`blob-spool\0${oid}`, signal, async (shared) => {
    let directory = await spoolDirectory();
    if (!(await stat(directory).catch(() => null))?.isDirectory()) {
      // Swept from under an idle worker: make a new one.
      spool = null;
      directory = await spoolDirectory();
    }
    const file = join(directory, oid);
    const size = Number((await runGit(repository, ["cat-file", "-s", oid], shared)).trim());
    if (!(size <= MAX_BLOB_BYTES)) throw new ButFailedError("That file is too large to preview.");
    const found = await stat(file).catch(() => null);
    if (found?.isFile() && found.size === size) return file;
    void sweepSpool(directory);
    const partial = `${file}.${randomUUID()}.partial`;
    try {
      await pipeGit(repository, ["cat-file", "blob", oid], shared, {
        sink: createWriteStream(partial, { mode: 0o600 }),
      });
      if ((await stat(partial)).size !== size)
        throw new ButFailedError("The file changed while it was read.");
      await rename(partial, file);
    } finally {
      await rm(partial, { force: true });
    }
    return file;
  });
}

/** One range of a blob or LFS object in `repository`, base64-encoded for the host call. */
export async function readBlobChunk(
  repository: string,
  object: BlobObject,
  offset: number,
  length: number,
  signal: AbortSignal,
): Promise<{ size: number; content: string }> {
  let file: string;
  if (object.kind === "lfs") {
    if (object.size > MAX_BLOB_BYTES)
      throw new ButFailedError("That file is too large to preview.");
    file =
      (await storedObject(repository, object, signal)) ??
      (await share(`lfs-fetch\0${repository}\0${object.oid}`, signal, (shared) =>
        fetchObject(repository, object, shared),
      ));
  } else {
    if (!OID.test(object.oid)) throw new ButFailedError("That is not a Git object id.");
    // The spool is shared, so the object must belong to this repository too.
    const type = (await runGit(repository, ["cat-file", "-t", object.oid], signal)).trim();
    if (type !== "blob") throw new ButFailedError("That object is not a file.");
    file = await spooledBlob(repository, object.oid, signal);
  }
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const wanted = Math.max(0, Math.min(Math.min(length, MAX_CHUNK_BYTES), size - offset));
    const buffer = Buffer.alloc(wanted);
    const { bytesRead } = await handle.read(buffer, 0, wanted, offset);
    return { size, content: buffer.subarray(0, bytesRead).toString("base64") };
  } finally {
    await handle.close();
  }
}
