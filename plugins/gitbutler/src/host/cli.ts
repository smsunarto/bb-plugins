import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * bb's host daemon does not inherit a login shell, so `but` is often absent
 * from PATH even when the user has it. These are the locations its own
 * installer, Homebrew, and cargo use.
 */
const EXTRA_PATH_ENTRIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(homedir(), ".local/bin"),
  join(homedir(), ".cargo/bin"),
];

/** The CLI is missing entirely, rather than unhappy about this repository. */
export class ButMissingError extends Error {}
/** The repository is a Git worktree that `but setup` has not been run on. */
export class ButSetupRequiredError extends Error {}
/** `but` ran and refused: bad target, locked repository, broken project. */
export class ButFailedError extends Error {}

function searchPath(env: NodeJS.ProcessEnv): string {
  const existing = (env["PATH"] ?? "").split(delimiter).filter((entry) => entry !== "");
  const merged = [...existing];
  for (const entry of EXTRA_PATH_ENTRIES) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  return merged.join(delimiter);
}

type RunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  spawnFailed: boolean;
  /** Past `MAX_OUTPUT_BYTES`, where Node kills the child, so there is no exit code. */
  overflowed: boolean;
};

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<RunResult> {
  return new Promise((settle) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        signal,
        windowsHide: true,
        env: { ...process.env, PATH: searchPath(process.env) },
      },
      (error, stdout, stderr) => {
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
  });
}

/**
 * Node reports the same ENOENT whether the program or the working directory
 * is missing, and `error.path` is the program name either way. A repository
 * that moved out from under a stale panel would otherwise be reported as a
 * missing GitButler install, which is the wrong thing to tell the user.
 */
async function spawnFailure(program: string, cwd: string): Promise<Error> {
  try {
    await access(cwd);
  } catch {
    return new ButFailedError("The repository directory is no longer available.");
  }
  return program === "but"
    ? // No backticks: the panel renders this message as plain text, so Markdown
      // syntax would reach the reader literally.
      new ButMissingError("The GitButler CLI (but) is not installed on this environment's host.")
    : new ButFailedError(`${program} is not installed on this host.`);
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
  if (signal.aborted) throw new Error("aborted");
  if (result.spawnFailed) throw await spawnFailure("but", cwd);

  const payload = parseJson(result.stdout);
  const failure = structuredError(payload);
  if (failure) {
    if (failure.error === "setup_required") throw new ButSetupRequiredError(failure.message);
    throw new ButFailedError(failure.message);
  }
  if (result.code !== 0) {
    throw new ButFailedError(firstLine(result.stderr) || `but ${args[0] ?? ""} failed.`);
  }
  if (payload === undefined) {
    throw new ButFailedError(`but ${args[0] ?? ""} did not return JSON.`);
  }
  return payload;
}

/**
 * `but`'s refusal as one readable line. Its stderr is `Error: <what>`, then
 * `Caused by:` and the reason, then a `Hint:` naming more CLI commands. The
 * panel shows what and why, without the prefixes or the hint. A failed fetch
 * instead dumps git's argv and output, so only git's own `fatal:` lines say
 * what went wrong.
 */
/**
 * libgit2's own words for a checkout blocked by files that still hold
 * conflict markers, which a pull or a delete runs into after an earlier one
 * left them, said the way the panel's notice says it.
 */
function plainly(message: string): string {
  return /unresolved conflicts exist in the index/.test(message)
    ? "Files still hold conflict markers. Resolve them in your editor or GitButler, then try again."
    : message;
}

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
 * Run a `but` command that changes the repository. Unlike a read, success
 * often prints nothing at all (`reword`, `land`), so only the exit status and
 * a structured `{ error }` decide the outcome. A success can still carry
 * news: the JSON it printed, if any, and warnings on stderr.
 */
export async function runButAction(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<{ payload: unknown; stderr: string }> {
  const result = await run("but", [...args, "--json"], cwd, signal);
  if (signal.aborted) throw new Error("aborted");
  if (result.spawnFailed) throw await spawnFailure("but", cwd);
  const payload = parseJson(result.stdout);
  const failure = structuredError(payload);
  if (failure) throw new ButFailedError(plainly(failure.message));
  if (result.code !== 0) {
    throw new ButFailedError(plainly(refusal(result.stderr) || `but ${args[0] ?? ""} failed.`));
  }
  return { payload, stderr: result.stderr };
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const result = await run("git", args, cwd, signal);
  if (signal.aborted) throw new Error("aborted");
  if (result.spawnFailed) throw await spawnFailure("git", cwd);
  // History is read a page at a time, so only a diff grows this large.
  if (result.overflowed) throw new ButFailedError("This diff is too large to show.");
  if (result.code !== 0) {
    throw new ButFailedError(firstLine(result.stderr) || "git failed.");
  }
  return result.stdout;
}
