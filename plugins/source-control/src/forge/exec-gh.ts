/**
 * The real `gh` runner, used both by the bb server and by a checkout's host:
 * `experimental_execHostFileCallback` resolves `gh` through bb's host
 * toolchain, so it is found without a login shell on macOS and Ubuntu.
 */
import type { ExecFileException } from "node:child_process";
import { experimental_execHostFileCallback as execFile } from "@get-bb/plugin-sdk/process";
import type { Exec, RunResult } from "./github.ts";

const TIMEOUT_MS = 15_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * What a finished `execFile` call means. When the runner killed `gh`
 * itself the output is cut short, so it is dropped rather than classified.
 * Ported from `plugins/code-review/src/server/lib/gh.ts`.
 */
export function runResult(
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
): RunResult {
  if (error?.code === "ENOENT") return { code: 127, stdout: "", stderr: "ENOENT: gh not found" };
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return { code: 1, stdout: "", stderr: "", failure: "too-large" };
  if (error?.killed) return { code: 1, stdout: "", stderr: "", failure: "timeout" };
  const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
  return { code, stdout, stderr };
}

export const execGh: Exec = (args, { stdin, signal }) =>
  new Promise<RunResult>((resolve) => {
    const child = execFile(
      "gh",
      args,
      {
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        ...(signal ? { signal } : {}),
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
      },
      (error, stdout, stderr) => resolve(runResult(error, String(stdout), String(stderr))),
    );
    // gh can exit before reading stdin; an unheard EPIPE would crash the process.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin);
  });
