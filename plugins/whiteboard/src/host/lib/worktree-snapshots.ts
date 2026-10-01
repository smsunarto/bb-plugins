import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  gitAt,
  gitCommonDir,
  type LocalVcs,
} from "../../shared/node/vendor/local-vcs/src/index.ts";
import {
  inspectWorktree,
  EMPTY_SOURCE,
  workingFiles,
  localSourcePath,
} from "../../shared/node/vendor/review/src/review-api/worktree-source.ts";
import { ReviewInputError } from "../../shared/vendor/review/src/review-api/input-error.ts";

const prefix = (repositoryId: string) =>
  `refs/bb-whiteboard/worktrees/${createHash("sha256").update(repositoryId).digest("hex")}/`;

const ref = (repositoryId: string, revision: string) => {
  if (revision === EMPTY_SOURCE) return `${prefix(repositoryId)}empty`;
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw new ReviewInputError("Invalid retained working source revision.");
  return `${prefix(repositoryId)}${revision}`;
};

async function repositoryEnv(vcs: LocalVcs) {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_ATTR_SOURCE",
  ])
    delete env[key];
  if (vcs.kind === "jj") {
    const common = await gitCommonDir(vcs.rootPath);
    if (!common) throw new ReviewInputError("Working source requires a Git-backed repository.");
    env.GIT_DIR = common;
    env.GIT_WORK_TREE = vcs.rootPath;
  }
  return env;
}

const snapshotGit = async (
  vcs: LocalVcs,
  args: string[],
  options: { allowFailure?: boolean } = {},
) => gitAt(vcs.rootPath, args, { ...options, env: await repositoryEnv(vcs) });

/** Saved Git trees survive worker reloads and GC without moving the user's branch or index. */
export async function retainedWorktreeTree(
  repositoryId: string,
  revision: string,
  vcs: LocalVcs,
  comparison = false,
) {
  const tree = await snapshotGit(
    vcs,
    [
      "rev-parse",
      "--verify",
      `${ref(repositoryId, revision)}${comparison && revision !== EMPTY_SOURCE ? "-diff" : ""}^{tree}`,
    ],
    {
      allowFailure: true,
    },
  );
  // Older saved generations used one tree for source and comparison.
  if (!tree.ok && comparison && revision !== EMPTY_SOURCE)
    return retainedWorktreeTree(repositoryId, revision, vcs);
  if (!tree.ok)
    throw new ReviewInputError(
      "The retained working source is unavailable. Refresh the current Whiteboard source.",
      404,
    );
  return tree.stdout.trim();
}

export async function retainedWorktreeHead(repositoryId: string, revision: string, vcs: LocalVcs) {
  await retainedWorktreeTree(repositoryId, revision, vcs);
  const name = `${ref(repositoryId, revision)}-head`;
  const type = await snapshotGit(vcs, ["cat-file", "-t", name], { allowFailure: true });
  if (!type.ok) return null;
  return type.stdout.trim() === "commit"
    ? (await snapshotGit(vcs, ["rev-parse", name])).stdout.trim()
    : EMPTY_SOURCE;
}

const quotePath = (file: string) =>
  `"${[...Buffer.from(file)].map((byte) => (byte < 32 || byte >= 127 ? `\\${byte.toString(8).padStart(3, "0")}` : byte === 34 || byte === 92 ? `\\${String.fromCharCode(byte)}` : String.fromCharCode(byte))).join("")}"`;

const gitInput = (root: string, args: string[], env: NodeJS.ProcessEnv, input: string) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(
      "git",
      ["-C", root, ...args],
      { env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
    // The process callback carries Git's useful diagnostic if the child closes stdin early.
    child.stdin!.on("error", () => {}).end(input);
  });

type IndexEntries = Map<string, { mode: string; oid: string }>;
function parseIndexEntries(output: string): IndexEntries {
  return new Map(
    output
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const header = line.slice(0, tab);
        const file = line.slice(tab + 1);
        const [mode, oid] = header.split(" ");
        return [file!, { mode: mode!, oid: oid! }];
      }),
  );
}
async function indexEntries(vcs: LocalVcs) {
  return parseIndexEntries((await snapshotGit(vcs, ["ls-files", "--stage", "-z"])).stdout);
}

async function canonicalEntries(
  vcs: LocalVcs,
  env: NodeJS.ProcessEnv,
  tracked: IndexEntries,
  files: string[],
) {
  await gitAt(vcs.rootPath, ["-c", "core.splitIndex=false", "read-tree", "--empty"], { env });
  if (tracked.size)
    await gitInput(
      vcs.rootPath,
      ["-c", "core.splitIndex=false", "update-index", "-z", "--index-info"],
      env,
      [...tracked].map(([file, entry]) => `${entry.mode} ${entry.oid}\t${file}\0`).join(""),
    );
  if (files.length)
    await gitInput(
      vcs.rootPath,
      ["-c", "core.splitIndex=false", "update-index", "--add", "--remove", "-z", "--stdin"],
      env,
      files.join("\0") + "\0",
    );
  return parseIndexEntries(
    (await gitAt(vcs.rootPath, ["ls-files", "--stage", "-z"], { env })).stdout,
  );
}

async function nestedHead(vcs: LocalVcs, file: string, indexed?: { mode: string; oid: string }) {
  const root = path.join(vcs.rootPath, file);
  const env = await repositoryEnv({ ...vcs, kind: "git", rootPath: root });
  const top = await gitAt(root, ["rev-parse", "--show-toplevel"], { env, allowFailure: true });
  if (top.ok && path.resolve(top.stdout.trim()) === path.resolve(root)) {
    const head = await gitAt(root, ["rev-parse", "--verify", "HEAD"], { env, allowFailure: true });
    if (head.ok) return head.stdout.trim();
  }
  return indexed?.mode === "160000" ? indexed.oid : undefined;
}

async function captureTree(vcs: LocalVcs) {
  const common = await gitCommonDir(vcs.rootPath);
  if (!common) throw new ReviewInputError("Working source requires a Git-backed repository.");
  const scratch = await mkdtemp(path.join(tmpdir(), "bb-whiteboard-tree-"));
  const env = await repositoryEnv(vcs);
  env.GIT_INDEX_FILE = path.join(scratch, "index");
  env.GIT_OPTIONAL_LOCKS = "0";
  const git = async (args: string[]) =>
    (await gitAt(vcs.rootPath, ["-c", "core.splitIndex=false", ...args], { env })).stdout.trim();
  try {
    await git(["read-tree", "--empty"]);
    const tracked = await indexEntries(vcs);
    const blobs: { file: string; path: string; mode: string }[] = [];
    const links: string[] = [];
    const listed = await workingFiles(vcs);
    const present = new Set(listed);
    const sparse = await snapshotGit(vcs, ["ls-files", "-v", "-z"]);
    for (const entry of sparse.stdout.split("\0")) {
      if (entry.slice(0, 2).toUpperCase() !== "S ") continue;
      const file = entry.slice(2);
      const indexed = tracked.get(file);
      if (indexed && !present.has(file)) links.push(`${indexed.mode} ${indexed.oid}\t${file}\0`);
    }
    const inspectFile = async (listedFile: string, index: number) => {
      const file = listedFile.replace(/\/$/, "");
      const candidate = path.join(vcs.rootPath, file);
      const info = await lstat(candidate);
      if (info.isDirectory()) {
        const commit = await nestedHead(vcs, file, tracked.get(file));
        if (commit) links.push(`160000 ${commit}\t${file}\0`);
      } else if (info.isSymbolicLink()) {
        const saved = path.join(scratch, `link-${index}`);
        await writeFile(saved, await readlink(candidate));
        blobs.push({ file, path: saved, mode: "120000" });
      } else {
        const mode = info.mode & 0o111 ? "100755" : "100644";
        blobs.push({
          file,
          path: await localSourcePath(vcs.rootPath, file),
          mode,
        });
      }
    };
    for (let start = 0; start < listed.length; start += 64)
      await Promise.all(
        listed.slice(start, start + 64).map((file, index) => inspectFile(file, start + index)),
      );
    let hashes: string[] = [];
    if (blobs.length) {
      hashes = (
        await gitInput(
          vcs.rootPath,
          ["hash-object", "-w", "--no-filters", "--stdin-paths"],
          env,
          blobs.map((blob) => quotePath(blob.path)).join("\n") + "\n",
        )
      ).split("\n");
    }
    // Native index conversion preserves Git's indexed-CRLF, attribute and mode rules.
    // Fresh entries omit the user's stat cache and optimization flags.
    const canonical = await canonicalEntries(
      vcs,
      env,
      tracked,
      blobs.map((blob) => blob.file),
    );
    const populate = async (raw: boolean) => {
      await git(["read-tree", "--empty"]);
      const entries = [
        ...links,
        ...blobs.map((blob, index) => {
          const converted = canonical.get(blob.file);
          if (!converted)
            throw Object.assign(new Error("Working file disappeared during capture."), {
              code: "ENOENT",
            });
          return `${raw ? blob.mode : converted.mode} ${raw ? hashes[index] : converted.oid}\t${blob.file}\0`;
        }),
      ];
      if (entries.length)
        await gitInput(vcs.rootPath, ["update-index", "-z", "--index-info"], env, entries.join(""));
      return git(["write-tree"]);
    };
    const tree = await populate(true);
    const comparison = await populate(false);
    await writeFile(path.join(scratch, "empty"), "");
    const empty = await git(["hash-object", "-w", "-t", "tree", path.join(scratch, "empty")]);
    return { tree, comparison, empty };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Inspect and retain the exact generation, retrying if files move during capture. */
const inspections = new Map<
  string,
  { metadata: string; source: { revision: string; commit: string } }
>();
async function cachedSource(repositoryId: string, vcs: LocalVcs, metadata: string) {
  const cached = inspections.get(`${repositoryId}\0${vcs.rootPath}`);
  if (cached?.metadata !== metadata) return undefined;
  try {
    await retainedWorktreeTree(repositoryId, cached.source.revision, vcs);
    return cached.source;
  } catch (error) {
    if (!(error instanceof ReviewInputError) || error.status !== 404) throw error;
    return undefined;
  }
}
async function inspectMetadata(repositoryId: string, vcs: LocalVcs) {
  const source = await inspectWorktree(repositoryId, vcs);
  const hash = createHash("sha256").update(source.revision);
  const tracked = await indexEntries(vcs);
  hash.update((await snapshotGit(vcs, ["config", "--null", "--show-origin", "--list"])).stdout);
  const common = await gitCommonDir(vcs.rootPath);
  const index = (
    await snapshotGit(vcs, ["rev-parse", "--path-format=absolute", "--git-path", "index"])
  ).stdout.trim();
  const globalAttributes = await snapshotGit(vcs, ["config", "--path", "core.attributesFile"], {
    allowFailure: true,
  });
  const attributes = [
    ...(common ? [path.join(common, "info/attributes")] : []),
    ...(globalAttributes.ok
      ? [path.resolve(vcs.rootPath, globalAttributes.stdout.trim())]
      : [
          path.join(
            process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || tmpdir(), ".config"),
            "git/attributes",
          ),
        ]),
  ];
  for (const file of [index, ...attributes]) {
    const info = await lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (info) hash.update(`\0${file}\0${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
    if (attributes.includes(file)) {
      const bytes = await readFile(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return Buffer.alloc(0);
      });
      hash.update(bytes);
    }
  }
  for (const file of await workingFiles(vcs)) {
    if (tracked.get(file)?.mode === "160000" || file.endsWith("/"))
      hash.update(
        `\0${file}\0${await nestedHead(vcs, file.replace(/\/$/, ""), tracked.get(file))}`,
      );
  }
  return { ...source, metadata: hash.digest("hex") };
}
export async function inspectRetainedWorktree(repositoryId: string, vcs: LocalVcs) {
  const key = `${repositoryId}\0${vcs.rootPath}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const before = await inspectMetadata(repositoryId, vcs);
      const cached = await cachedSource(repositoryId, vcs, before.metadata);
      if (cached) return cached;
      const { tree, comparison, empty } = await captureTree(vcs);
      const after = await inspectMetadata(repositoryId, vcs);
      if (before.metadata !== after.metadata) continue;
      const source = {
        commit: before.commit,
        revision: createHash("sha256")
          .update(`${repositoryId}\0${before.commit}\0${tree}\0${comparison}`)
          .digest("hex"),
      };
      await snapshotGit(vcs, ["update-ref", ref(repositoryId, source.revision), tree]);
      await snapshotGit(vcs, [
        "update-ref",
        `${ref(repositoryId, source.revision)}-diff`,
        comparison,
      ]);
      await snapshotGit(vcs, [
        "update-ref",
        `${ref(repositoryId, source.revision)}-head`,
        before.commit === EMPTY_SOURCE ? empty : before.commit,
      ]);
      // A pre-snapshot authored version can be recovered only when its exact metadata is still current.
      const alias = await snapshotGit(
        vcs,
        ["update-ref", ref(repositoryId, before.revision), tree, ""],
        { allowFailure: true },
      );
      if (!alias.ok) await retainedWorktreeTree(repositoryId, before.revision, vcs);
      if (alias.ok)
        await snapshotGit(vcs, [
          "update-ref",
          `${ref(repositoryId, before.revision)}-diff`,
          comparison,
          "",
        ]);
      await snapshotGit(vcs, ["update-ref", ref(repositoryId, EMPTY_SOURCE), empty]);
      inspections.set(key, { metadata: before.metadata, source });
      if (inspections.size > 64) inspections.delete(inspections.keys().next().value!);
      return source;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !/No such file or directory/.test(String(error))
      )
        throw error;
    }
  }
  throw new ReviewInputError(
    "Working files changed while capturing source. Retry the operation.",
    409,
  );
}

/** Keep authored history and the two live generations that a mounted reader can still hold. */
export async function pruneWorktreeTrees(repositoryId: string, vcs: LocalVcs, revisions: string[]) {
  const keep = new Set([
    ref(repositoryId, EMPTY_SOURCE),
    ...revisions.flatMap((revision) => [
      ref(repositoryId, revision),
      `${ref(repositoryId, revision)}-diff`,
      `${ref(repositoryId, revision)}-head`,
    ]),
  ]);
  const listed = await snapshotGit(vcs, [
    "for-each-ref",
    "--format=%(refname)",
    prefix(repositoryId),
  ]);
  for (const name of listed.stdout.trim().split("\n").filter(Boolean))
    if (!keep.has(name)) await snapshotGit(vcs, ["update-ref", "-d", name]);
}
