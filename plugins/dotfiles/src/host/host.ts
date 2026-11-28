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

/** Which quoting rules the login shell reads a command with. */
export type ShellFamily = "posix" | "fish";

interface LoginShell {
  readonly path: string;
  readonly args: readonly string[];
  readonly family: ShellFamily;
}

/**
 * `value` as one single-quoted word that `family` reads back verbatim. POSIX
 * single quotes take every byte literally, so a quote closes, escapes, and
 * reopens. fish reads `\'` and `\\` inside single quotes as escapes, so
 * POSIX quoting would let a trailing backslash swallow the closing quote.
 */
export function quoteForShell(value: string, family: ShellFamily): string {
  // Neither shell can receive NUL in an argument; spawn would reject the command.
  if (value.includes("\0")) throw new Error("a shell argument cannot contain NUL");
  return family === "fish"
    ? `'${value.replaceAll(/[\\']/g, "\\$&")}'`
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `command` followed by each of `args` as a literal word for `family`. */
export function shellCommand(
  command: string,
  args: readonly string[],
  family: ShellFamily,
): string {
  return [command, ...args.map((arg) => quoteForShell(arg, family))].join(" ");
}

/** The timer calls a task makes, so tests can see what a settled task leaves behind. */
export interface TaskTimers {
  readonly set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clear: (timer: ReturnType<typeof setTimeout>) => void;
}

const systemTimers: TaskTimers = {
  // Read the globals per call, so fake timers installed later still apply.
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer),
};

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
      return { path: candidate, args: ["-l", "-c"], family: "fish" };
    }
  }
  return { path: "/bin/sh", args: ["-lc"], family: "posix" };
}

/**
 * Run a repo task through the login shell, so `mise` and the tools it
 * activates are on PATH. stdout and stderr are merged for display, so
 * nothing may parse this output: shell start-up noise lands in it too.
 *
 * `args` follow `command` as literal words, quoted for whichever shell runs.
 *
 * The shell leads its own process group, so a timeout or cancel stops
 * every process the task started, not the shell alone.
 */
export function runInLoginShell(
  command: string,
  cwd: string,
  signal: AbortSignal,
  args: readonly string[] = [],
  timers: TaskTimers = systemTimers,
): Promise<TaskResult> {
  const loginShell = resolveLoginShell();
  const script = shellCommand(command, args, loginShell.family);
  return new Promise((resolvePromise) => {
    // `detached` is setsid(2) on macOS and Linux: the shell's pid becomes the group id.
    const child = spawn(loginShell.path, [...loginShell.args, script], { cwd, detached: true });
    let output = "";
    let truncated = false;
    let settled = false;
    /** Why the task was stopped, appended after its output. */
    let stopNotice = "";
    /** A stop's SIGKILL, then its pipe drain. Each is pending only after a stop. */
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

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
      timers.clear(timer);
      signal.removeEventListener("abort", cancel);
      // A settled task needs no drain. Its SIGKILL still matters while a member
      // that ignores SIGTERM outlives the pipes, so it stays, but never keeps
      // the host daemon alive; with the group gone it has nothing to do.
      if (drainTimer !== undefined) timers.clear(drainTimer);
      if (killTimer !== undefined) {
        if (groupAlive()) killTimer.unref?.();
        else timers.clear(killTimer);
      }
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

    const groupAlive = (): boolean => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
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

    const stop = (notice: string): void => {
      if (stopNotice) return;
      stopNotice = notice;
      killGroup("SIGTERM");
      killTimer = timers.set(() => {
        killTimer = undefined;
        killGroup("SIGKILL");
        if (settled) return;
        // A process that left the group can hold the pipes open indefinitely.
        drainTimer = timers.set(() => {
          drainTimer = undefined;
          child.stdout.destroy();
          child.stderr.destroy();
          finish(child.exitCode);
        }, drainGraceMs);
      }, killGraceMs);
    };
    const cancel = (): void => stop("\n[cancelled]");

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = timers.set(
      () => stop(`\n[timed out after ${taskTimeoutMs / 1000}s]`),
      taskTimeoutMs,
    );
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

    run({ repoPath, command, args }, { signal }) {
      return runInLoginShell(command, expandHome(repoPath), signal, args);
    },
  },
});
