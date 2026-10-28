// Runs core's bootstrap argv inside a Boat sandbox. Boat's command API has no
// stdin and caps a waiting command at ten minutes, so the command runs
// detached with its stdin staged in /tmp (never snapshotted), and the plugin
// follows its output through the attach stream until it exits.
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { withBoatRetry, type BoatClient, type BoatOffsets } from "./boat-api.ts";

/** Boat's JSON file write accepts 5 MiB after decoding. */
const MAX_STDIN_BYTES = 5 * 1024 * 1024;
const REATTACH_LIMIT = 5;
const REATTACH_DELAY_MS = 1_000;

export interface ExecutorDeps {
  randomId(): string;
  sleep(delayMs: number): Promise<void>;
}

export function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", String.raw`'\''`)}'`;
}

/** The shell line Boat runs: argv with stdin redirected from the staged file, which is removed afterwards. */
export function shellCommand(argv: readonly string[], stdinPath: string | null): string {
  const program = argv.map(shellQuote).join(" ");
  if (stdinPath === null) return `${program} < /dev/null`;
  const file = shellQuote(stdinPath);
  return `{ ${program}; } < ${file}; rc=$?; rm -f ${file}; exit $rc`;
}

export function createBoatExecutor(
  client: BoatClient,
  sandboxId: string,
  deps: ExecutorDeps,
): MachineExecutor {
  async function follow(
    processId: number,
    signal: AbortSignal,
    onOutput: (chunk: string) => void,
  ): Promise<number> {
    const offsets: BoatOffsets = { stdout: 0, stderr: 0 };
    for (let endedEarly = 0; ;) {
      const outcome = await followOnce(processId, offsets, signal, onOutput);
      if (outcome.kind === "exit") return exitCodeOf(outcome.result);
      if (outcome.kind === "reconnect") continue;
      // The stream closed or failed without an exit frame: ask once whether the process is really gone.
      signal.throwIfAborted();
      const status = await client.commandStatus(sandboxId, processId, signal);
      if (!status.running) return exitCodeOf(status);
      // Drops are counted per quiet stretch: a long command may lose its stream many times and still finish.
      endedEarly = outcome.progressed ? 1 : endedEarly + 1;
      if (endedEarly >= REATTACH_LIMIT) {
        throw new Error(
          `Boat closed the command stream ${endedEarly} times while the command still ran${
            outcome.kind === "failed" ? `: ${outcome.error.message}` : ""
          }`,
        );
      }
      await deps.sleep(REATTACH_DELAY_MS);
      signal.throwIfAborted();
    }
  }

  type FollowOutcome =
    | { kind: "exit"; result: CommandResult }
    | { kind: "reconnect" }
    | { kind: "closed"; progressed: boolean }
    | { kind: "failed"; error: Error; progressed: boolean };

  /** One attach stream, updating `offsets` in place so the next attach resumes where this one stopped. */
  async function followOnce(
    processId: number,
    offsets: BoatOffsets,
    signal: AbortSignal,
    onOutput: (chunk: string) => void,
  ): Promise<FollowOutcome> {
    let progressed = false;
    try {
      for await (const frame of client.attach(sandboxId, processId, offsets, signal)) {
        switch (frame.type) {
          case "stdout":
          case "stderr":
            onOutput(frame.data);
            offsets[frame.type] = frame.nextOffset;
            progressed = true;
            break;
          case "exit":
            return { kind: "exit", result: { status: frame.status, exitCode: frame.exitCode } };
          case "reconnect":
            offsets.stdout = frame.stdoutOffset;
            offsets.stderr = frame.stderrOffset;
            return { kind: "reconnect" };
          case "error":
            return {
              kind: "failed",
              progressed,
              error: new Error(
                `Boat could not attach to the command: ${frame.error} ${frame.message}`.trim(),
              ),
            };
          default:
            break;
        }
      }
      return { kind: "closed", progressed };
    } catch (error) {
      // A dropped connection is retried; a cancelled or timed-out exec is not.
      if (signal.aborted) throw error;
      return {
        kind: "failed",
        progressed,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  return {
    async exec({ command, stdin, timeoutMs, signal, onOutput }) {
      signal.throwIfAborted();
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = AbortSignal.any([signal, timeout]);
      const stdinPath = stdin.length === 0 ? null : `/tmp/bb-exec-${deps.randomId()}.stdin`;
      // Right after a resume the machine may still be mounting its files; Boat says which calls to repeat.
      const retry = { signal: combined, sleep: deps.sleep };
      let processId: number | null = null;
      try {
        if (stdinPath !== null) {
          const encoded = Buffer.from(stdin, "utf8");
          if (encoded.byteLength > MAX_STDIN_BYTES) {
            throw new Error(
              `Command stdin of ${encoded.byteLength} bytes exceeds Boat's 5 MiB file write.`,
            );
          }
          const content = encoded.toString("base64");
          await withBoatRetry(
            "file",
            () => client.writeFile(sandboxId, stdinPath, content, "base64", combined),
            retry,
          );
        }
        const line = shellCommand(command, stdinPath);
        processId = await withBoatRetry(
          "command",
          () => client.startCommand(sandboxId, line, combined),
          retry,
        );
        const exitCode = await follow(processId, combined, onOutput);
        return { exitCode };
      } catch (error) {
        // Whatever stopped the follow, the detached process must not outlive this call.
        if (processId !== null) await client.stopCommand(sandboxId, processId).catch(() => {});
        if (timeout.aborted && !signal.aborted) {
          throw new Error(`Boat command timed out after ${timeoutMs} ms`, { cause: error });
        }
        throw error;
      } finally {
        // The staged stdin may hold enrollment credentials: remove it even when the upload's outcome is unknown.
        if (stdinPath !== null) await client.deleteFile(sandboxId, stdinPath).catch(() => {});
      }
    },
  };
}

type CommandResult = { status: "running" | "exited" | "lost"; exitCode: number | null };

function exitCodeOf(result: CommandResult): number {
  if (result.exitCode !== null) return result.exitCode;
  if (result.status === "lost") {
    throw new Error(
      "Boat lost track of the command (its agent restarted); the exit code is unknown.",
    );
  }
  return 1;
}
