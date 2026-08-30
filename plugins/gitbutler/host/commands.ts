import type { ExecFileException, ExecFileOptionsWithStringEncoding } from "node:child_process";
import { GITBUTLER_VERSION, type CommitIntent } from "../shared/domain.ts";
import {
  parseBranchNames023,
  parseStatus023,
  parseWorktreeDiff023,
  type GitButlerCliSelector,
  type RawDiffEnvelope023,
  type RawStatus023,
} from "./parser.ts";

const KIB = 1024;
const MIB = 1024 * KIB;

export type ButCommandFailureKind =
  | "cancelled"
  | "invalid-output"
  | "missing"
  | "non-zero"
  | "output-limit"
  | "timeout"
  | "unsupported-version";

export class ButCommandError extends Error {
  readonly kind: ButCommandFailureKind;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    kind: ButCommandFailureKind,
    message: string,
    details: { stdout?: string; stderr?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: details.cause });
    this.name = "ButCommandError";
    this.kind = kind;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
  }
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding & { encoding: "utf8" },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

interface RunPolicy {
  readonly timeout: number;
  readonly maxBuffer: number;
}

export interface FixedButCommands {
  version(cwd: string, signal: AbortSignal): Promise<typeof GITBUTLER_VERSION>;
  status(cwd: string, signal: AbortSignal): Promise<RawStatus023>;
  worktreeDiff(cwd: string, signal: AbortSignal): Promise<RawDiffEnvelope023>;
  branchNames(cwd: string, signal: AbortSignal): Promise<ReadonlySet<string>>;
  commit(
    cwd: string,
    input: {
      readonly message: CommitIntent["message"];
      readonly branchName: string;
      readonly hunks: readonly GitButlerCliSelector[];
    },
    signal: AbortSignal,
  ): Promise<void>;
}

function classifyExecError(error: ExecFileException, signal: AbortSignal): ButCommandFailureKind {
  if (signal.aborted || error.name === "AbortError" || error.code === "ABORT_ERR")
    return "cancelled";
  if (error.code === "ENOENT") return "missing";
  if (
    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    error.message.toLowerCase().includes("maxbuffer")
  ) {
    return "output-limit";
  }
  if (error.killed === true) return "timeout";
  return "non-zero";
}

export function createFixedButCommands(execFile: ExecFileLike): FixedButCommands {
  const run = (
    cwd: string,
    args: readonly string[],
    signal: AbortSignal,
    policy: RunPolicy,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      execFile(
        "but",
        args,
        {
          cwd,
          encoding: "utf8",
          maxBuffer: policy.maxBuffer,
          shell: false,
          signal,
          timeout: policy.timeout,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ stdout, stderr });
            return;
          }
          const kind = classifyExecError(error, signal);
          reject(
            new ButCommandError(kind, `but ${args[0] ?? "command"} failed`, {
              stdout,
              stderr,
              cause: error,
            }),
          );
        },
      );
    });

  return {
    async version(cwd, signal) {
      const { stdout } = await run(cwd, ["--version"], signal, {
        timeout: 5_000,
        maxBuffer: 64 * KIB,
      });
      const match = /^but ([^\s]+)\s*$/u.exec(stdout);
      if (match?.[1] !== GITBUTLER_VERSION) {
        throw new ButCommandError(
          "unsupported-version",
          `Expected but ${GITBUTLER_VERSION}, received ${match?.[1] ?? "an invalid version"}`,
          { stdout },
        );
      }
      return GITBUTLER_VERSION;
    },

    async status(cwd, signal) {
      const { stdout } = await run(cwd, ["status", "-f", "--json"], signal, {
        timeout: 10_000,
        maxBuffer: 4 * MIB,
      });
      try {
        return parseStatus023(stdout);
      } catch (cause) {
        throw new ButCommandError("invalid-output", "GitButler returned invalid status JSON", {
          stdout,
          cause,
        });
      }
    },

    async worktreeDiff(cwd, signal) {
      const { stdout } = await run(cwd, ["diff", "--json"], signal, {
        timeout: 10_000,
        maxBuffer: 4 * MIB,
      });
      try {
        return parseWorktreeDiff023(stdout);
      } catch (cause) {
        throw new ButCommandError("invalid-output", "GitButler returned invalid diff JSON", {
          stdout,
          cause,
        });
      }
    },

    async branchNames(cwd, signal) {
      const { stdout } = await run(
        cwd,
        ["branch", "list", "--all", "--empty", "--no-check", "--no-ahead", "--json"],
        signal,
        { timeout: 10_000, maxBuffer: 4 * MIB },
      );
      try {
        return parseBranchNames023(stdout);
      } catch (cause) {
        throw new ButCommandError("invalid-output", "GitButler returned invalid branch JSON", {
          stdout,
          cause,
        });
      }
    },

    async commit(cwd, input, signal) {
      await run(
        cwd,
        ["commit", "-b", input.branchName, "-m", input.message, ...input.hunks],
        signal,
        { timeout: 30_000, maxBuffer: 4 * MIB },
      );
    },
  };
}
