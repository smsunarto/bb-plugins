import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Resolve directory aliases and MPPM's shared Assets without requiring a Rampage marker. */
export async function resolveWorkspacePath(
  path: string,
): Promise<{ workspacePath: string | null }> {
  let root: string;
  try {
    root = await realpath(path);
  } catch (error) {
    if (missing(error)) return { workspacePath: null };
    throw error;
  }
  try {
    return { workspacePath: dirname(await realpath(join(root, "Assets"))) };
  } catch (error) {
    if (missing(error)) return { workspacePath: root };
    throw error;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function containedPath(root: string, path: string, optional = false): Promise<string | null> {
  let canonical;
  try {
    canonical = await realpath(join(root, path));
  } catch (error) {
    if (optional && missing(error)) {
      // A dangling symlink is not an absent directory.
      try {
        await lstat(join(root, path));
      } catch (entryError) {
        if (missing(entryError)) return null;
        throw entryError;
      }
    }
    throw new Error(`Cannot inspect ${path} in the checkout`, { cause: error });
  }
  if (!inside(root, canonical))
    throw new Error(
      `${path} resolves outside the checkout; shared Unity directories cannot be slots`,
    );
  return canonical;
}

async function jsonMarker(root: string, path: string): Promise<Record<string, unknown>> {
  const canonical = await containedPath(root, path);
  const value: unknown = JSON.parse(await readFile(canonical!, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must contain a JSON object`);
  return value as Record<string, unknown>;
}

/** Inspect an existing independent Rampage checkout without changing its files or Git state. */
export async function inspectRampageWorkspace(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!isAbsolute(path)) throw new Error("A slot requires an absolute checkout path");
  const workspacePath = await realpath(path);
  const git = await lstat(join(workspacePath, ".git"));
  if (!git.isDirectory() || git.isSymbolicLink())
    throw new Error(
      "A Rampage slot requires its own .git directory; linked worktrees are unsupported",
    );
  let sharedGit = false;
  try {
    await lstat(join(workspacePath, ".git/commondir"));
    sharedGit = true;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (sharedGit) throw new Error("Shared Git common directories cannot be Rampage slots");
  for (const directory of ["Assets", "Packages", "ProjectSettings", "Library", "Temp"]) {
    const resolved = await containedPath(
      workspacePath,
      directory,
      ["Library", "Temp"].includes(directory),
    );
    if (resolved && !(await lstat(resolved)).isDirectory())
      throw new Error(`${directory} must be a directory`);
  }
  const packageMarker = await jsonMarker(workspacePath, "package.json");
  const assembly = await jsonMarker(
    workspacePath,
    "Assets/Rampage/Editor/ArgusLabs.Rampage.Editor.asmdef",
  );
  if (packageMarker.name !== "rampage-client" || assembly.name !== "ArgusLabs.Rampage.Editor")
    throw new Error("The checkout is not the Rampage client");
  const manifest = await jsonMarker(workspacePath, "Packages/manifest.json");
  const dependencies = manifest.dependencies;
  if (
    !dependencies ||
    typeof dependencies !== "object" ||
    Array.isArray(dependencies) ||
    Object.values(dependencies).some((value) => typeof value !== "string" || !value)
  )
    throw new Error("Packages/manifest.json must contain Unity package dependencies");
  const versionPath = await containedPath(workspacePath, "ProjectSettings/ProjectVersion.txt");
  const version = await readFile(versionPath!, "utf8");
  const matches = [...version.matchAll(/^m_EditorVersion: (\d+\.\d+\.\d+[abcfpx]\d+)\s*$/gm)];
  if (matches.length !== 1)
    throw new Error("ProjectVersion.txt has no unambiguous Unity Editor version");
  signal?.throwIfAborted();
  return { workspacePath, projectVersion: matches[0]![1]! };
}

export interface WorkspaceEditorProcess {
  pid: number;
  /** null means the Editor exists but its project could not be established safely. */
  projectPath: string | null;
}

export interface WorkspaceProcessInspection {
  listEditors(signal?: AbortSignal): Promise<WorkspaceEditorProcess[]>;
}

function projectArgument(argv: string[]): string | null {
  const paths: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (/^-projectpath$/i.test(arg)) paths.push(argv[++index] ?? "");
    else if (/^-projectpath=/i.test(arg)) paths.push(arg.slice(arg.indexOf("=") + 1));
  }
  return paths.length === 1 && isAbsolute(paths[0]!) ? paths[0]! : null;
}

function flattenedProjectArgument(commandLine: string): string | null {
  // ps flattens argv on macOS. Quoted values and spaces are retained; an ambiguous value fails
  // realpath below rather than letting an Editor be treated as unrelated.
  const matches = [
    ...commandLine.matchAll(
      /(?:^|\s)-projectpath(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(.+?))(?=\s+-[a-z]|$)/gi,
    ),
  ];
  if (matches.length !== 1) return null;
  const path = (matches[0]![1] ?? matches[0]![2] ?? matches[0]![3] ?? "").trim();
  return isAbsolute(path) ? path : null;
}

async function listEditors(signal?: AbortSignal): Promise<WorkspaceEditorProcess[]> {
  if (process.platform === "win32") {
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'Unity.exe'\" -ErrorAction Stop | Select-Object ProcessId,CommandLine) -Compress",
      ],
      { signal, timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
    );
    const value: unknown = JSON.parse(stdout);
    const entries = Array.isArray(value) ? value : [value];
    return entries.map((entry: unknown) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        !Number.isInteger((entry as { ProcessId?: unknown }).ProcessId)
      )
        throw new Error("Cannot verify the Unity process inventory");
      const candidate = entry as { ProcessId: number; CommandLine?: unknown };
      return {
        pid: candidate.ProcessId,
        projectPath:
          typeof candidate.CommandLine === "string"
            ? flattenedProjectArgument(candidate.CommandLine)
            : null,
      };
    });
  }
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error("Unity process inspection is unavailable on this host");
  const { stdout } = await exec("ps", ["-ax", "-ww", "-o", "pid=", "-o", "comm="], {
    signal,
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const rows = stdout.trim().split("\n");
  if (!stdout.trim()) throw new Error("Cannot verify an empty OS process inventory");
  const editors: WorkspaceEditorProcess[] = [];
  for (const row of rows) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(row);
    if (!match) throw new Error("Cannot verify the OS process inventory");
    if (!/^unity(?:\.exe)?$/i.test(basename(match[2]!.trim()))) continue;
    const pid = Number(match[1]);
    try {
      const command =
        process.platform === "linux"
          ? await readFile(`/proc/${pid}/cmdline`, "utf8")
          : (
              await exec("ps", ["-ww", "-p", String(pid), "-o", "args="], {
                signal,
                timeout: 5000,
                maxBuffer: 1024 * 1024,
              })
            ).stdout;
      editors.push({
        pid,
        projectPath:
          process.platform === "linux"
            ? projectArgument(command.split("\0").filter(Boolean))
            : flattenedProjectArgument(command),
      });
    } catch (error) {
      // The Editor may have exited between snapshots. Retrying is safe; guessing is not.
      throw new Error(`Cannot inspect Unity Editor process ${pid}; retry after it has stopped`, {
        cause: error,
      });
    }
  }
  return editors;
}

async function assertNoLock(workspacePath: string) {
  await containedPath(workspacePath, "Temp", true);
  try {
    await lstat(join(workspacePath, "Temp/UnityLockfile"));
  } catch (error) {
    if (missing(error)) return;
    throw new Error("Cannot inspect UnityLockfile; the checkout cannot be handed off", {
      cause: error,
    });
  }
  throw new Error(
    "UnityLockfile is present; close Unity before handing off the slot. A stale lock requires manual inspection.",
  );
}

/** Refuse handoff while any main or shared-Assets Editor is open, including without Pipeline. */
export async function assertWorkspaceStopped(
  path: string,
  signal?: AbortSignal,
  inspection: WorkspaceProcessInspection = { listEditors },
): Promise<void> {
  signal?.throwIfAborted();
  const workspacePath = await realpath(path);
  const assetsPath = await containedPath(workspacePath, "Assets");
  await assertNoLock(workspacePath);
  const editors = await inspection.listEditors(signal);
  for (const editor of editors) {
    if (!editor.projectPath)
      throw new Error(
        `Unity Editor ${editor.pid} has no verifiable project path; close it before handing off a slot`,
      );
    const projectPath = await realpath(editor.projectPath);
    const projectAssets = await realpath(join(projectPath, "Assets"));
    if (
      projectPath === workspacePath ||
      projectAssets === assetsPath ||
      inside(workspacePath, projectPath)
    )
      throw new Error(
        `Unity Editor ${editor.pid} is still using this slot; close the Editor and its MPPM clients before handoff`,
      );
  }
  signal?.throwIfAborted();
  await assertNoLock(workspacePath);
}
