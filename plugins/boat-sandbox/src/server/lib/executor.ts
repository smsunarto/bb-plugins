// Runs core's bootstrap argv inside a Boat sandbox. Boat's command API has no
// stdin and caps a waiting command at ten minutes, so the command runs
// detached with its stdin staged in /tmp (never snapshotted), and the plugin
// follows its output through the attach stream until it exits.
import type { PluginRuntime } from "@bb-plugins/effect-bridge";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { Effect, Exit, Option, Stream } from "effect";
import {
  REQUEST_TIMEOUT_MS,
  retryBoat,
  type BoatAttachFrame,
  type BoatClient,
  type BoatOffsets,
} from "./boat-api.ts";
import { call } from "./call.ts";

/** Boat's JSON file write accepts 5 MiB after decoding. */
const MAX_STDIN_BYTES = 5 * 1024 * 1024;
const REATTACH_LIMIT = 5;
const REATTACH_DELAY_MS = 1_000;
/**
 * Boat sends a heartbeat after 15 s without output, so a stream that sends nothing for a whole
 * request timeout has stalled even though its connection is open.
 */
const ATTACH_IDLE_MS = REQUEST_TIMEOUT_MS;

export interface ExecutorDeps {
  randomId(): string;
  /** Runs the exec on the plugin's runtime, which interrupts it when core's signal aborts. */
  run: PluginRuntime<never>["run"];
}

type ExecRequest = Parameters<MachineExecutor["exec"]>[0];

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

type CommandResult = { status: "running" | "exited" | "lost"; exitCode: number | null };

/** How one attach stream ended. */
type FollowOutcome =
  | { kind: "exit"; result: CommandResult }
  | { kind: "reconnect" }
  | { kind: "closed"; progressed: boolean }
  | { kind: "failed"; error: Error; progressed: boolean };

export function createBoatExecutor(
  client: BoatClient,
  sandboxId: string,
  deps: ExecutorDeps,
): MachineExecutor {
  /** One attach stream, updating `offsets` in place so the next attach resumes where this one stopped. */
  function followOnce(
    processId: number,
    offsets: BoatOffsets,
    onOutput: (chunk: string) => void,
  ): Effect.Effect<FollowOutcome> {
    let progressed = false;
    const settle = (frame: BoatAttachFrame): FollowOutcome | null => {
      switch (frame.type) {
        case "stdout":
        case "stderr":
          onOutput(frame.data);
          offsets[frame.type] = frame.nextOffset;
          progressed = true;
          return null;
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
          return null;
      }
    };
    return client.attach(sandboxId, processId, offsets).pipe(
      // A stream that is silent, without even a heartbeat, ends here and is attached again.
      Stream.timeout(ATTACH_IDLE_MS),
      Stream.map(settle),
      Stream.filter((outcome) => outcome !== null),
      Stream.runHead,
      Effect.map(Option.getOrElse((): FollowOutcome => ({ kind: "closed", progressed }))),
      // A dropped connection is attached again; a cancelled or timed-out exec interrupts instead.
      Effect.catch((error) =>
        Effect.succeed<FollowOutcome>({
          kind: "failed",
          progressed,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      ),
    );
  }

  const follow = Effect.fnUntraced(function* (
    processId: number,
    onOutput: (chunk: string) => void,
  ): Effect.fn.Return<number, unknown> {
    const offsets: BoatOffsets = { stdout: 0, stderr: 0 };
    for (let endedEarly = 0; ;) {
      const outcome = yield* followOnce(processId, offsets, onOutput);
      if (outcome.kind === "exit") return yield* exitCodeOf(outcome.result);
      if (outcome.kind === "reconnect") continue;
      // The stream closed or failed without an exit frame: ask once whether the process is really gone.
      const status = yield* call((signal) => client.commandStatus(sandboxId, processId, signal));
      if (!status.running) return yield* exitCodeOf(status);
      // Drops are counted per quiet stretch: a long command may lose its stream many times and still finish.
      endedEarly = outcome.progressed ? 1 : endedEarly + 1;
      if (endedEarly >= REATTACH_LIMIT) {
        return yield* Effect.fail(
          new Error(
            `Boat closed the command stream ${endedEarly} times while the command still ran${
              outcome.kind === "failed" ? `: ${outcome.error.message}` : ""
            }`,
          ),
        );
      }
      yield* Effect.sleep(REATTACH_DELAY_MS);
    }
  });

  function exec({ command, stdin, timeoutMs, onOutput }: ExecRequest) {
    const stdinPath = stdin.length === 0 ? null : `/tmp/bb-exec-${deps.randomId()}.stdin`;
    // Right after a resume the machine may still be mounting its files; Boat says which calls to repeat.
    // Each start runs to Boat's answer, and a started command's stop joins the scope with its ID, so a
    // cancel lands between repeats without losing a command Boat already started.
    const runCommand = Effect.scoped(
      retryBoat("command")(
        Effect.acquireRelease(
          call((signal) =>
            client.startCommand(sandboxId, shellCommand(command, stdinPath), signal),
          ),
          // Whatever stopped the follow, the detached process must not outlive this call.
          (processId, exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.ignore(call(() => client.stopCommand(sandboxId, processId))),
        ),
      ).pipe(Effect.flatMap((processId) => follow(processId, onOutput))),
    );
    const staged = Effect.suspend(() => {
      if (stdinPath === null) return runCommand;
      const encoded = Buffer.from(stdin, "utf8");
      if (encoded.byteLength > MAX_STDIN_BYTES) {
        return Effect.fail(
          new Error(
            `Command stdin of ${encoded.byteLength} bytes exceeds Boat's 5 MiB file write.`,
          ),
        );
      }
      const content = encoded.toString("base64");
      return retryBoat("file")(
        call((signal) => client.writeFile(sandboxId, stdinPath, content, "base64", signal)),
      ).pipe(
        Effect.andThen(runCommand),
        // The staged stdin may hold enrollment credentials: remove it even when the upload's outcome is unknown.
        Effect.ensuring(Effect.ignore(call(() => client.deleteFile(sandboxId, stdinPath)))),
      );
    });
    return staged.pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(new Error(`Boat command timed out after ${timeoutMs} ms`)),
      }),
      Effect.map((exitCode) => ({ exitCode })),
    );
  }

  return { exec: (request) => deps.run(exec(request), request.signal) };
}

function exitCodeOf(result: CommandResult): Effect.Effect<number, Error> {
  if (result.exitCode !== null) return Effect.succeed(result.exitCode);
  if (result.status === "lost") {
    return Effect.fail(
      new Error("Boat lost track of the command (its agent restarted); the exit code is unknown."),
    );
  }
  return Effect.succeed(1);
}
