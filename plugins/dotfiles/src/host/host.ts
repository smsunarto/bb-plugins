import {
  experimental_execHostFileCallback as execFile,
  experimental_spawnHostProcess as spawn,
} from "@get-bb/plugin-sdk/process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  groupDefinitions,
  type GitEntry,
  type TaskResult,
  type TweakableDefinition,
} from "../shared/domain.ts";
import { dotfilesHostContract } from "../shared/host-contract.ts";

const outputCap = 200_000;
const taskTimeoutMs = 300_000;
/** From SIGTERM to SIGKILL: time a stopped task gets to clean up. */
const killGraceMs = 2_000;
/** From SIGKILL to settling, even while a process that left the task's group holds its pipes. */
const drainGraceMs = 1_000;
const gitTimeoutMs = 30_000;
const gitMaxBuffer = 16 * 1024 * 1024;

/** The fixed file list. Discovered skills exist by construction. */
const fixedPaths = groupDefinitions([]).flatMap((group) => group.files.map((file) => file.path));

interface LoginShell {
  readonly path: string;
  readonly args: readonly string[];
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function resolveLoginShell(): LoginShell {
  const candidates = [
    process.env.SHELL,
    "/opt/homebrew/bin/fish",
    "/usr/local/bin/fish",
    "/usr/bin/fish",
  ];
  for (const candidate of candidates) {
    if (candidate?.endsWith("/fish") && existsSync(candidate)) {
      return { path: candidate, args: ["-l", "-c"] };
    }
  }
  return { path: "/bin/sh", args: ["-lc"] };
}

/**
 * Run a repo task through the login shell, so `mise` and the tools it
 * activates are on PATH. stdout and stderr are merged for display, so
 * nothing may parse this output: shell start-up noise lands in it too.
 *
 * The shell leads its own process group, so a timeout or cancel stops
 * every process the task started, not the shell alone.
 */
function runInLoginShell(command: string, cwd: string, signal: AbortSignal): Promise<TaskResult> {
  const loginShell = resolveLoginShell();
  return new Promise((resolvePromise) => {
    // `detached` is setsid(2) on macOS and Linux: the shell's pid becomes the group id.
    const child = spawn(loginShell.path, [...loginShell.args, command], { cwd, detached: true });
    let output = "";
    let truncated = false;
    let settled = false;
    /** Why the task was stopped, appended after its output. */
    let stopNotice = "";

    const append = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      const remaining = outputCap - output.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      output += text.slice(0, remaining);
      if (text.length > remaining) truncated = true;
    };

    const settle = (result: TaskResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      // `error`, `close`, and a stop's drain can all fire. The `settled`
      // guard makes this exact-once even though static promise lint cannot
      // prove it.
      /* oxlint-disable-next-line promise/no-multiple-resolved */
      resolvePromise(result);
    };
    const finish = (code: number | null): void => {
      settle({
        exitCode: code ?? 1,
        output: `${output}${truncated ? "\n[output truncated]" : ""}${stopNotice}`,
      });
    };

    const killGroup = (killSignal: NodeJS.Signals): void => {
      // No pid means the spawn failed. `process.kill(-0)` would signal our own group.
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, killSignal);
      } catch {
        // Every process in the group has exited.
      }
    };

    // Neither timer is cleared on settle. A member that ignores SIGTERM can
    // outlive the pipes, and the drain is a no-op once settled.
    const stop = (notice: string): void => {
      if (stopNotice) return;
      stopNotice = notice;
      killGroup("SIGTERM");
      setTimeout(() => {
        killGroup("SIGKILL");
        // A process that left the group can hold the pipes open indefinitely.
        setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(child.exitCode);
        }, drainGraceMs);
      }, killGraceMs);
    };
    const cancel = (): void => stop("\n[cancelled]");

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(stop, taskTimeoutMs, `\n[timed out after ${taskTimeoutMs / 1000}s]`);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    child.on("close", finish);
    child.on("error", (error) => {
      settle({
        exitCode: 127,
        output: `${output}${output ? "\n" : ""}${String(error)}`,
      });
    });
  });
}

/**
 * Git output the plugin parses. git runs directly, never through the login
 * shell: a shell config that fails on this machine writes to stderr, and
 * that text must not become a status entry or a line of a HEAD file.
 * Resolves `null` when git fails.
 */
function git(
  repoPath: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      args,
      { cwd: repoPath, encoding: "utf8", maxBuffer: gitMaxBuffer, timeout: gitTimeoutMs, signal },
      (error, stdout) => resolvePromise(error ? null : stdout),
    );
  });
}

async function gitStatus(
  repoPath: string,
  signal: AbortSignal,
): Promise<{ branch: string; entries: GitEntry[] }> {
  const output = await git(repoPath, ["status", "--porcelain=v1", "-b"], signal);
  if (output === null) return { branch: "unknown", entries: [] };
  const lines = output.split("\n").filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## "));
  const branch = branchLine?.slice(3).split("...")[0] ?? "unknown";
  return {
    branch,
    entries: lines
      .filter((line) => !line.startsWith("## "))
      .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) })),
  };
}

function discoverSkills(repoPath: string): TweakableDefinition[] {
  const skillsDirectory = join(repoPath, ".dotfiles/.agents/skills");
  if (!existsSync(skillsDirectory)) return [];
  return readdirSync(skillsDirectory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(skillsDirectory, entry.name, "SKILL.md")),
    )
    .map((entry) => ({
      path: `.dotfiles/.agents/skills/${entry.name}/SKILL.md`,
      title: entry.name,
    }))
    .sort((left, right) => left.title.localeCompare(right.title));
}

export default experimental_defineHostEntry({
  contract: dotfilesHostContract,
  handlers: {
    async inspect({ repoPath }, { signal }) {
      const expanded = expandHome(repoPath);
      if (!existsSync(expanded)) return { repo: "missing" as const, repoPath: expanded };
      // bb's file API refuses a symlinked root, and ~/git/dotfiles is one on
      // some machines, so editor reads and writes use the real directory.
      const root = realpathSync(expanded);
      return {
        repo: "found" as const,
        repoPath: root,
        ...(await gitStatus(root, signal)),
        skills: discoverSkills(root),
        missingPaths: fixedPaths.filter((path) => !existsSync(join(root, path))),
      };
    },

    async readHead({ repoPath, path }, { signal }) {
      return { content: await git(expandHome(repoPath), ["show", `HEAD:${path}`], signal) };
    },

    run({ repoPath, command }, { signal }) {
      return runInLoginShell(command, expandHome(repoPath), signal);
    },
  },
});
