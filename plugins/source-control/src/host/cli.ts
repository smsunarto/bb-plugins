/**
 * Running `git` and `but` on the checkout's host. Ported from
 * `plugins/gitbutler/src/host/cli.ts`. Programs are found through the SDK's
 * host toolchain, which searches the login shell's PATH and the usual
 * install locations (`~/.local/bin`, Homebrew, `/usr/local/bin`), so no PATH
 * list is kept here.
 */
import { access } from "node:fs/promises";
import { experimental_execHostFileCallback as execFile } from "@get-bb/plugin-sdk/process";
import { ownProcess } from "./repository-state.ts";

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** A program the read or write needs is not installed on this host. */
export class ToolMissingError extends Error {
  readonly tool: "git" | "but";
  constructor(tool: "git" | "but", message: string) {
    super(message);
    this.tool = tool;
  }
}
/** The repository is a Git worktree that GitButler has not been set up in. */
export class ButSetupRequiredError extends Error {}
/** `git` or `but` ran and refused: bad target, locked repository, broken project. */
export class CommandFailedError extends Error {}

type RunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  spawnFailed: boolean;
  /** Past `MAX_OUTPUT_BYTES`, where Node kills the child, so there is no exit code. */
  overflowed: boolean;
};

type RunOptions = {
  input?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Whether what it writes in a watched repository is taken as ours. Off for
   * commands that write nothing, such as `check-ignore`, so they never hide
   * someone else's change.
   */
  own?: boolean;
};

function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function run(
  command: "git" | "but",
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  { input, env = process.env, own = true }: RunOptions = {},
): Promise<RunResult> {
  // What it writes in a watched repository is ours, not a change to report.
  const exited = own ? ownProcess(cwd) : async () => undefined;
  return new Promise<RunResult>((settle) => {
    const child = execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        signal,
        windowsHide: true,
        env: {
          ...env,
          ...(command === "git"
            ? // No prompts, English messages to read, and no index refresh by reads.
              { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }
            : {}),
        },
      },
      (error, stdout, stderr) => {
        void exited();
        const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
        settle({
          stdout,
          stderr,
          code,
          spawnFailed: Boolean(error) && (error as NodeJS.ErrnoException).code === "ENOENT",
          overflowed: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        });
      },
    );
    // A short-lived command can close its pipe before Node closes our end.
    // Its exit callback owns the result, including any refusal on stderr.
    child.stdin?.on("error", () => undefined);
    if (input === undefined) child.stdin?.end();
    else child.stdin?.end(input);
  }).catch((error: unknown) => {
    // It never started, so it wrote nothing.
    void exited();
    throw error;
  });
}

/**
 * Node reports the same ENOENT whether the program or the working directory
 * is missing. A checkout that moved away would otherwise read as a missing
 * install, which is the wrong thing to tell the reader.
 */
async function spawnFailure(program: "git" | "but", cwd: string): Promise<Error> {
  try {
    await access(cwd);
  } catch {
    return new CommandFailedError("The checkout directory is no longer available.");
  }
  // No backticks: the panel renders this message as plain text.
  return program === "but"
    ? new ToolMissingError("but", "The GitButler CLI (but) is not installed on this host.")
    : new ToolMissingError("git", "git is not installed on this host.");
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function structuredError(payload: unknown): { error: string; message: string } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record["error"] !== "string") return undefined;
  const message = typeof record["message"] === "string" ? record["message"] : record["error"];
  return { error: record["error"], message };
}

/**
 * Run `but ... --json` and return the parsed payload. `but` reports refusals
 * two ways: a structured `{ error }` object on stdout when it understood the
 * request, and plain stderr text when it did not — both exit 1.
 */
export async function runBut(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<unknown> {
  const result = await run("but", [...args, "--json"], cwd, signal);
  if (signal.aborted) throw aborted(signal);
  if (result.spawnFailed) throw await spawnFailure("but", cwd);

  const payload = parseJson(result.stdout);
  const failure = structuredError(payload);
  if (failure) {
    if (failure.error === "setup_required") throw new ButSetupRequiredError(failure.message);
    throw new CommandFailedError(failure.message);
  }
  if (result.code !== 0) {
    throw new CommandFailedError(firstLine(result.stderr) || `but ${args[0] ?? ""} failed.`);
  }
  if (payload === undefined) {
    throw new CommandFailedError(`but ${args[0] ?? ""} did not return JSON.`);
  }
  return payload;
}

/**
 * libgit2's own words for a checkout blocked by files that still hold
 * conflict markers, said the way the panel says it.
 */
function plainly(message: string): string {
  return /unresolved conflicts exist in the index/.test(message)
    ? "Files still hold conflict markers. Resolve them in your editor or GitButler, then try again."
    : message;
}

/**
 * `but`'s refusal as one readable line. Its stderr is `Error: <what>`, then
 * `Caused by:` and the reason, then a `Hint:` naming more CLI commands. A
 * failed fetch instead dumps git's argv and output, so only git's own
 * `fatal:` lines say what went wrong.
 */
function refusal(stderr: string): string {
  const lines = stderr.split("\n").map((line) => line.trim());
  const fatal = lines.filter((line) => line.startsWith("fatal:"));
  if (fatal.length > 0) {
    return `Could not reach the remote. ${fatal.map((line) => line.replace(/^fatal:\s*/, "")).join(" ")}`;
  }
  const hint = lines.findIndex((line) => line.startsWith("Hint:"));
  return (hint === -1 ? lines : lines.slice(0, hint))
    .filter((line) => line !== "" && line !== "Caused by:")
    .map((line) => line.replace(/^Error:\s*/, ""))
    .join(" ");
}

/**
 * Run a `but` command that changes the repository. Success often prints
 * nothing at all (`land`), so only the exit status and a structured
 * `{ error }` decide the outcome.
 */
export async function runButAction(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<{ payload: unknown; stderr: string }> {
  const result = await run("but", [...args, "--json"], cwd, signal);
  if (signal.aborted) throw aborted(signal);
  if (result.spawnFailed) throw await spawnFailure("but", cwd);
  const payload = parseJson(result.stdout);
  const failure = structuredError(payload);
  if (failure) throw new CommandFailedError(plainly(failure.message));
  if (result.code !== 0) {
    throw new CommandFailedError(plainly(refusal(result.stderr) || `but ${args[0] ?? ""} failed.`));
  }
  return { payload, stderr: result.stderr };
}

/**
 * Configured SSH commands can be wrappers or PuTTY, and must retain Git's
 * own precedence and arguments. Use stock SSH's noninteractive mode only
 * when the network command has no custom SSH configuration.
 */
async function networkEnvironment(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  let commandIndex = 0;
  while (args[commandIndex] === "-c" || args[commandIndex] === "-C") commandIndex += 2;
  if (
    ["fetch", "push", "pull", "clone", "ls-remote", "lfs"].includes(args[commandIndex] ?? "") &&
    environment["GIT_SSH_COMMAND"] === undefined &&
    environment["GIT_SSH"] === undefined
  ) {
    const configured = await run(
      "git",
      [...args.slice(0, commandIndex), "config", "--get", "core.sshCommand"],
      cwd,
      signal,
      { env: environment },
    );
    if (configured.code === 1) environment["GIT_SSH_COMMAND"] = "ssh -oBatchMode=yes";
  }
  return environment;
}

/** Git plumbing such as diff and merge-tree uses exit 1 for a meaningful result. */
export async function runGitCommand(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env = await networkEnvironment(cwd, args, signal, { ...process.env, ...options.env });
  const result = await run("git", args, cwd, signal, { ...options, env });
  if (signal.aborted) throw aborted(signal);
  if (result.spawnFailed) throw await spawnFailure("git", cwd);
  // History is read a page at a time, so only a diff grows this large.
  if (result.overflowed) throw new CommandFailedError("This diff is too large to show.");
  return result;
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  options: RunOptions = {},
): Promise<string> {
  const result = await runGitCommand(cwd, args, signal, options);
  if (result.code !== 0) {
    throw new CommandFailedError(firstLine(result.stderr) || "git failed.");
  }
  return result.stdout;
}

/** stdout trimmed, or null when git answers "no" with exit 1 (an absent ref or setting). */
export async function optionalGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string | null> {
  const result = await runGitCommand(cwd, args, signal);
  if (result.code === 0) return result.stdout.trim() || null;
  if (result.code === 1) return null;
  throw new CommandFailedError(result.stderr.trim() || "Git could not read this repository.");
}
