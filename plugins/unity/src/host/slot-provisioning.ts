import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { devNull } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  assertWorkspaceStopped,
  inspectRampageWorkspace,
  type WorkspaceProcessInspection,
} from "./slot-workspaces.ts";

const exec = promisify(execFile);
interface ProvisionInput {
  sourcePath: string;
  path: string;
  branch: string;
  operationId: string;
}
interface ProvisionResult {
  workspacePath: string;
  projectVersion: string;
  sourceCommit: string;
  branch: string;
  cacheSeed: "copy-on-write";
}
interface Receipt {
  version: 1;
  input: ProvisionInput;
  owner: { pid: number; startedAt: string };
  state: "preparing" | "failed" | "ready";
  result?: ProvisionResult;
}
interface ProvisionOptions {
  inspection?: WorkspaceProcessInspection;
  /** Test the host filesystem boundary without making a non-CoW production fallback. */
  cloneFile?: typeof copyFile;
}
type CloneFiles = (files: [string, string][], signal?: AbortSignal) => Promise<void>;

// libuv does not implement COPYFILE_FICLONE_FORCE on Darwin. Call clonefile directly,
// once per batch, and treat every native failure as fatal instead of silently copying.
const darwinClone = `import ctypes, json, os, stat, sys
libc = ctypes.CDLL(None, use_errno=True)
libc.clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
libc.clonefile.restype = ctypes.c_int
for source, destination in json.load(sys.stdin):
    if not stat.S_ISREG(os.lstat(source).st_mode):
        raise RuntimeError("CoW source must be a regular file: " + source)
    if libc.clonefile(os.fsencode(source), os.fsencode(destination), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), source)
    if not stat.S_ISREG(os.lstat(destination).st_mode):
        raise RuntimeError("CoW destination must be a regular file: " + destination)
`;

function nativeCloneFiles(override?: typeof copyFile): CloneFiles {
  return async (files, signal) => {
    if (process.platform === "darwin" && !override && files.length) {
      const pending = exec("python3", ["-c", darwinClone], {
        signal,
        timeout: 25 * 60 * 1000,
        maxBuffer: 1024 * 1024,
      });
      pending.child.stdin!.on("error", () => {}); // The process promise reports spawn/exit failures.
      pending.child.stdin!.end(JSON.stringify(files));
      await pending;
      return;
    }
    for (const [source, destination] of files) {
      signal?.throwIfAborted();
      await (override ?? copyFile)(source, destination, constants.COPYFILE_FICLONE_FORCE);
    }
  };
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function git(path: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await exec("git", ["-c", `core.hooksPath=${devNull}`, "-C", path, ...args], {
    signal,
    timeout: 25 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout.trim();
}

async function sourceCheckpoint(path: string, lfsScratch: string, signal?: AbortSignal) {
  // Git status may run LFS clean filters. Redirect their object writes outside the source.
  if (
    await git(
      path,
      ["-c", `lfs.storage=${lfsScratch}`, "status", "--porcelain=v1", "--untracked-files=normal"],
      signal,
    )
  )
    throw new Error("The Rampage source must have no tracked or untracked changes");
  const sourceCommit = await git(path, ["rev-parse", "--verify", "HEAD"], signal);
  const remote = await git(path, ["remote", "get-url", "origin"], signal);
  // Preserve the real upstream, without embedding source credentials or a local checkout path.
  if (!/^(https?:\/\/|ssh:\/\/|[^\s/@]+@[^\s/:]+:)/.test(remote))
    throw new Error("The Rampage source needs a nonlocal origin remote");
  if (/^https?:\/\//.test(remote) && new URL(remote).username)
    throw new Error("The origin remote must not contain embedded credentials");
  return { sourceCommit, remote };
}

async function cloneTree(
  source: string,
  destination: string,
  files: [string, string][],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const info = await lstat(source);
  if (info.isSymbolicLink())
    throw new Error(`The cache contains a symlink; refusing to share ${source}`);
  if (info.isDirectory()) {
    await mkdir(destination);
    for (const entry of await readdir(source))
      await cloneTree(join(source, entry), join(destination, entry), files, signal);
  } else if (info.isFile()) {
    files.push([source, destination]);
  } else throw new Error(`Unsupported cache entry ${source}`);
}

async function seedLfs(
  source: string,
  destination: string,
  clone: CloneFiles,
  signal?: AbortSignal,
) {
  await git(destination, ["lfs", "install", "--local", "--skip-repo"], signal);
  const inventory: unknown = JSON.parse(
    await git(destination, ["lfs", "ls-files", "--json"], signal),
  );
  if (
    !inventory ||
    typeof inventory !== "object" ||
    ((inventory as { files?: unknown }).files !== null &&
      !Array.isArray((inventory as { files?: unknown }).files))
  )
    throw new Error("Cannot inspect Git LFS files in the new checkout");
  const objects = new Set<string>();
  for (const entry of (inventory as { files: unknown[] | null }).files ?? []) {
    const oid = entry && typeof entry === "object" ? (entry as { oid?: unknown }).oid : null;
    if (typeof oid !== "string" || !/^[a-f0-9]{64}$/.test(oid))
      throw new Error("Cannot inspect a Git LFS object identifier");
    objects.add(oid);
  }
  const files: [string, string][] = [];
  for (const oid of objects) {
    signal?.throwIfAborted();
    const objectPath = join(".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
    const sourceObject = await realpath(join(source, objectPath));
    if (!inside(join(source, ".git"), sourceObject) || !(await lstat(sourceObject)).isFile())
      throw new Error("A required Git LFS object is unavailable inside the source checkout");
    await mkdir(dirname(join(destination, objectPath)), { recursive: true });
    files.push([sourceObject, join(destination, objectPath)]);
  }
  if (objects.size) {
    await clone(files, signal);
    await git(destination, ["lfs", "fsck", "--objects", "HEAD"], signal);
    await git(destination, ["lfs", "checkout"], signal);
  }
}

async function reserveProvision(input: ProvisionInput, dataDir: string, signal?: AbortSignal) {
  const receipts = join(dataDir, "rampage-provisioning");
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const receiptPath = join(
    receipts,
    `${createHash("sha256").update(input.path).digest("hex")}.json`,
  );
  let receiptHandle;
  try {
    receiptHandle = await open(receiptPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = JSON.parse(await readFile(receiptPath, "utf8")) as Receipt;
    if (
      previous.version !== 1 ||
      ["sourcePath", "path", "branch", "operationId"].some(
        (key) =>
          previous.input?.[key as keyof ProvisionInput] !== input[key as keyof ProvisionInput],
      )
    )
      throw new Error("The destination is reserved by another provisioning operation", {
        cause: error,
      });
    if (previous.state !== "ready" || !previous.result)
      throw new Error(
        "The previous provisioning is incomplete; inspect its receipt and checkout before recovery",
        { cause: error },
      );
    const inspected = await inspectRampageWorkspace(input.path, signal);
    if (inspected.workspacePath !== previous.result.workspacePath)
      throw new Error("The provisioned checkout no longer matches its receipt", { cause: error });
    // Completed retries must never recopy caches or rewind a user's branch/files.
    return { receipt: previous, receiptPath, completed: true };
  }
  const receipt: Receipt = {
    version: 1,
    input,
    owner: {
      pid: process.pid,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
    state: "preparing",
  };
  try {
    await receiptHandle.writeFile(JSON.stringify(receipt));
    await receiptHandle.sync();
  } finally {
    await receiptHandle.close();
  }
  return { receipt, receiptPath, completed: false };
}

function preparationOwnerAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1)
    throw new Error("Cannot verify the provisioning owner process");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error(
      "Cannot verify whether source provisioning has stopped; keep the slot reserved",
      { cause: error },
    );
  }
}

/** Keep checkout handoff fenced while host provisioning can still be changing its files. */
export async function assertNoSlotPreparation(path: string, dataDir: string): Promise<void> {
  const canonical = await realpath(path);
  const directory = join(dataDir, "rampage-provisioning");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  for (const file of files.filter((file) => file.endsWith(".json"))) {
    const receipt = JSON.parse(await readFile(join(directory, file), "utf8")) as Receipt;
    if (
      receipt.version !== 1 ||
      !receipt.input ||
      typeof receipt.input.path !== "string" ||
      typeof receipt.input.sourcePath !== "string" ||
      !["preparing", "failed", "ready"].includes(receipt.state)
    )
      throw new Error(
        `Cannot verify provisioning receipt ${file}; inspect it before slot recovery`,
      );
    if (receipt.state === "ready") continue;
    if (receipt.input.path === canonical)
      throw new Error(
        "This checkout has incomplete provisioning; inspect its receipt and partial files before adoption or handoff",
      );
    if (receipt.state !== "preparing" || receipt.input.sourcePath !== canonical) continue;
    if (preparationOwnerAlive(receipt.owner?.pid))
      throw new Error("This source checkout is still reserved by a running provisioning process");
  }
}

/** Fresh independent Git checkout with a native CoW Library seed. No source files are changed. */
export async function provisionRampageSlot(
  requested: ProvisionInput,
  dataDir: string,
  signal?: AbortSignal,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  signal?.throwIfAborted();
  if (
    !isAbsolute(requested.path) ||
    !requested.operationId ||
    !/^scott\/[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(requested.branch)
  )
    throw new Error("Provisioning requires an absolute path, operation ID and scott/ task branch");
  const source = await inspectRampageWorkspace(requested.sourcePath, signal);
  const path = join(await realpath(dirname(requested.path)), basename(requested.path));
  if (inside(source.workspacePath, path) || inside(path, source.workspacePath))
    throw new Error("The new checkout and source checkout must be separate directories");
  const input = { ...requested, sourcePath: source.workspacePath, path };
  const { receipt, receiptPath, completed } = await reserveProvision(input, dataDir, signal);
  if (completed) return receipt.result!;
  const save = async () => {
    const temporary = `${receiptPath}.${requested.operationId.replace(/[^a-zA-Z0-9_-]/g, "_")}.tmp`;
    await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
    await rename(temporary, receiptPath);
  };
  try {
    if (await exists(path))
      throw new Error("The destination already exists; provisioning never overwrites directories");
    await assertWorkspaceStopped(source.workspacePath, signal, options.inspection);
    const lfsScratch = `${receiptPath}.lfs-scratch`;
    const checkpoint = await sourceCheckpoint(source.workspacePath, lfsScratch, signal);
    if (!(await exists(join(source.workspacePath, "Library"))))
      throw new Error("The source has no warm Library cache to seed");
    await git(source.workspacePath, ["check-ref-format", "--branch", requested.branch], signal);
    await mkdir(path);
    await git(
      dirname(path),
      ["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--", source.workspacePath, path],
      signal,
    );
    await git(path, ["remote", "set-url", "origin", checkpoint.remote], signal);
    await git(
      path,
      ["checkout", "--no-track", "-b", requested.branch, checkpoint.sourceCommit],
      signal,
    );
    const clone = nativeCloneFiles(options.cloneFile);
    await seedLfs(source.workspacePath, path, clone, signal);
    await mkdir(join(path, "Library"));
    const files: [string, string][] = [];
    for (const entry of await readdir(join(source.workspacePath, "Library"))) {
      // Pipeline contains live transport credentials; VP contains MPPM project clones/state.
      if (["pipeline", "vp"].includes(entry.toLowerCase())) continue;
      await cloneTree(
        join(source.workspacePath, "Library", entry),
        join(path, "Library", entry),
        files,
        signal,
      );
    }
    if (!files.length) throw new Error("The source Library contains no warm cache files to seed");
    await clone(files, signal);
    await assertWorkspaceStopped(source.workspacePath, signal, options.inspection);
    const after = await sourceCheckpoint(source.workspacePath, lfsScratch, signal);
    if (after.sourceCommit !== checkpoint.sourceCommit || after.remote !== checkpoint.remote)
      throw new Error("The source Git checkpoint changed during provisioning");
    const inspected = await inspectRampageWorkspace(path, signal);
    await assertWorkspaceStopped(path, signal, options.inspection);
    if (await git(path, ["status", "--porcelain=v1", "--untracked-files=normal"], signal))
      throw new Error("The new checkout is not clean after provisioning");
    signal?.throwIfAborted();
    const result: ProvisionResult = {
      workspacePath: inspected.workspacePath,
      projectVersion: inspected.projectVersion,
      sourceCommit: checkpoint.sourceCommit,
      branch: requested.branch,
      cacheSeed: "copy-on-write",
    };
    receipt.state = "ready";
    receipt.result = result;
    await save();
    return result;
  } catch (error) {
    receipt.state = "failed";
    await save();
    throw error;
  }
}
