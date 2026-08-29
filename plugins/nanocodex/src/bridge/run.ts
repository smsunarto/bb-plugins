/**
 * `src/bridge/run.ts` — one `nanocodex run` child, from argv to exit.
 *
 * Everything about invoking the CLI lives here: flag mapping, environment
 * hygiene, the bounded stdout line reader, the stderr tail, signals, and exit
 * classification. `session.ts` above it deals in turns, never in processes.
 *
 * The child is genuinely one-shot. It takes one positional prompt, reads no
 * stdin at all (grep-confirmed across run.rs and main.rs), streams JSONL, and
 * exits. There is no connection to keep, no request map, no responder — the
 * whole child-connection layer provider-codex needs for its app-server has no
 * counterpart here.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  experimental_readBoundedLines as readBoundedLines,
  experimental_recordProviderChildIo as recordProviderChildIo,
  sanitizeInheritedChildProcessEnv,
  withoutBridgeRuntimeEnv,
  type BridgeExecutionOptions,
} from "@get-bb/plugin-sdk/provider-bridge";
import { NANOCODEX_REASONING_LEVELS } from "../catalog.ts";
import { isTerminalKind, parseEventLine, type NanocodexEnvelope } from "./events.ts";

/** Everything the invocation needs, resolved before the spawn. */
export interface RunSpec {
  /** Absolute nanocodex path from `providerOptions`, or the test override. */
  readonly command: string;
  /** Argv prefix from the test override; empty in production. */
  readonly argsPrefix: readonly string[];
  readonly cwd: string;
  /** The composed prompt: the one positional argument. */
  readonly prompt: string;
  /** `--instructions` value, or null. It REPLACES nanocodex's system prompt, so `instructionMode: "append"` never sets it. */
  readonly instructions: string | null;
  readonly model: string | null;
  readonly thinking: string | null;
  /** bb service tier. "fast" adds `--fast-mode true` (priority processing); "default" and null emit nothing. */
  readonly serviceTier: "default" | "fast" | null;
  /** bb-injected `options.envVars` (PATH, BB_CLI, BB_THREAD_STORAGE, ...). */
  readonly envVars: Readonly<Record<string, string>>;
  readonly features: RunFeatures;
}

/**
 * The four nanocodex features that default to TRUE. Pinned explicitly on every
 * invocation so an install's behavior does not change under the plugin when a
 * default flips, and so `--mcp-defaults` (which silently attaches five built-in
 * docs MCP servers) is a visible choice rather than an ambient one.
 */
export interface RunFeatures {
  readonly subagents: boolean;
  readonly webSearch: boolean;
  readonly imageGeneration: boolean;
  readonly mcpDefaults: boolean;
}

/** How the run ended, from the bridge's point of view. */
export type RunOutcome =
  | { kind: "terminal" }
  /** Exited with no `run.completed`/`run.failed`. nanocodex's own loop calls this an error, and so do we. */
  | { kind: "no-terminal"; exitCode: number | null; stderrTail: string }
  /** ENOENT, EACCES: the CLI is gone or unusable. Carries a recovery hint. */
  | { kind: "spawn-failed"; message: string }
  /** SIGINT was sent and the child did not settle inside the grace window; it was SIGKILLed. */
  | { kind: "killed" };

export interface RunHandle {
  /**
   * Resolves when the child exits and its stdout is drained. Never rejects:
   * every failure is a `RunOutcome` value, because the caller must settle the
   * turn on every path and a thrown error is an easier path to forget.
   */
  readonly done: Promise<RunOutcome>;

  /**
   * Ask the child to stop. SIGINT first — nanocodex handles it
   * (`control.cancel()`) and normally emits `run.completed {status:"cancelled"}`
   * before exiting 1, which is a REAL terminal event and produces a real
   * interrupted boundary. After `INTERRUPT_GRACE_MS` it escalates to SIGKILL,
   * `done` resolves `killed`, and the caller synthesizes the boundary instead.
   *
   * Idempotent.
   */
  interrupt(): void;

  /** SIGKILL now, no grace, no deltas. `thread/stop {intent: "release"}` and bridge shutdown: never leave a child burning tokens for a thread nobody is watching. */
  abandon(): void;
}

/**
 * Spawn one turn's child and stream its events.
 *
 * `onEvent` is called synchronously per parsed line, in order. Backpressure is
 * the caller's problem and there is none in practice: the projector is
 * synchronous and the writer batches per macrotask.
 */
export function startRun(args: {
  spec: RunSpec;
  /** For `experimental_recordProviderChildIo`, which scopes the recording lanes. */
  threadId: string;
  onEvent: (envelope: NanocodexEnvelope) => void;
}): RunHandle {
  const { spec, threadId, onEvent } = args;
  const child = spawn(spec.command, [...spec.argsPrefix, ...buildRunArgv(spec)], {
    cwd: spec.cwd,
    env: buildChildEnv(spec),
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Unconditional; a no-op off record mode, and the ONLY way the parity lane
  // sees the child.
  recordProviderChildIo(child, { threadId });

  let sawTerminal = false;
  let killed = false;
  let interruptRequested = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let exited = false;
  let stderrTail = "";

  let resolveDone!: (outcome: RunOutcome) => void;
  let resolved = false;
  const done = new Promise<RunOutcome>((resolve) => {
    resolveDone = (outcome) => {
      if (resolved) return;
      resolved = true;
      resolve(outcome);
    };
  });

  if (child.stdout !== null) {
    readBoundedStdout(child.stdout, MAX_EVENT_LINE_BYTES, (line) => {
      const envelope = parseEventLine(line);
      if (envelope === null) return;
      if (isTerminalKind(envelope.type)) sawTerminal = true;
      onEvent(envelope);
    });
  }
  if (child.stderr !== null) {
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_BYTES);
    });
  }

  const clearGrace = (): void => {
    if (graceTimer === null) return;
    clearTimeout(graceTimer);
    graceTimer = null;
  };

  child.on("error", (error: NodeJS.ErrnoException) => {
    exited = true;
    clearGrace();
    resolveDone({
      kind: "spawn-failed",
      message: `failed to start ${spec.command}: ${error.message}`,
    });
  });

  child.on("close", (code) => {
    exited = true;
    clearGrace();
    if (sawTerminal) {
      resolveDone({ kind: "terminal" });
    } else if (killed) {
      resolveDone({ kind: "killed" });
    } else {
      resolveDone({ kind: "no-terminal", exitCode: code, stderrTail });
    }
  });

  return {
    done,
    interrupt() {
      if (exited || interruptRequested) return;
      interruptRequested = true;
      child.kill("SIGINT");
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (exited) return;
        killed = true;
        child.kill("SIGKILL");
      }, INTERRUPT_GRACE_MS);
      graceTimer.unref?.();
    },
    abandon() {
      if (exited) return;
      clearGrace();
      killed = true;
      child.kill("SIGKILL");
    },
  };
}

/**
 * The largest single JSONL line accepted. The tool-run fixture's longest line
 * is 47 KB (an `api.event`), so 1 MB is generous. An oversized line is dropped
 * and counted rather than buffered: a runaway line is the one failure mode that
 * can take the whole bridge process down with it.
 */
export const MAX_EVENT_LINE_BYTES = 1_000_000;

/** Bounded stderr, kept for the error message on a failed exit. */
export const STDERR_TAIL_BYTES = 64 * 1024;

/**
 * How long SIGINT gets before SIGKILL. nanocodex's own settle path waits
 * TURN_SETTLE_TIMEOUT = 5s (run.rs:10) before giving up on a clean cancel, so
 * the bridge must OUTLAST that window rather than race it: 5s here would
 * SIGKILL exactly when a slow child was about to emit its cancelled terminal.
 */
export const INTERRUPT_GRACE_MS = 6_000;

/** nanocodex's RETRYABLE_EXIT_CODE. Everything else non-zero is a plain failure with `Error: {debug}` on stderr. */
export const RETRYABLE_EXIT_CODE = 75;

/**
 * The argv, in a fixed order so a recording diffs cleanly.
 *
 *   run <prompt> --cwd <dir> [--model m] [--thinking t] [--instructions i]
 *   [--fast-mode true] --subagents <bool> --web-search <bool>
 *   --image-generation <bool> --mcp-defaults <bool> --browser=none
 *
 * `--browser=none` must be the single-token `=` form: the value is optional,
 * so `--browser none` is a parse error. Omitting the flag is not safe either.
 * The default is `brave`, and startup hard-fails before `run.started` on any
 * machine without a Brave profile (verified live: exit 1, "failed to locate
 * the standard Brave profile"). `none` also keeps the browser's desktop
 * cookie copy out of headless bridge turns.
 *
 * `--rollouts` is deliberately left at its default (true): the bridge never
 * reads rollout files, but leaving them on lets a user open the session in the
 * nanocodex TUI as an escape hatch.
 */
export function buildRunArgv(spec: RunSpec): string[] {
  return [
    "run",
    spec.prompt,
    "--cwd",
    spec.cwd,
    ...(spec.model === null ? [] : ["--model", spec.model]),
    ...(spec.thinking === null ? [] : ["--thinking", spec.thinking]),
    ...(spec.instructions === null ? [] : ["--instructions", spec.instructions]),
    ...(spec.serviceTier === "fast" ? ["--fast-mode", "true"] : []),
    "--subagents",
    String(spec.features.subagents),
    "--web-search",
    String(spec.features.webSearch),
    "--image-generation",
    String(spec.features.imageGeneration),
    "--mcp-defaults",
    String(spec.features.mcpDefaults),
    "--browser=none",
  ];
}

/**
 * The child's environment.
 *
 * `withoutBridgeRuntimeEnv(sanitizeInheritedChildProcessEnv({env: process.env}))`
 * then `options.envVars` on top. Without the sanitizer every `BB_*` variable —
 * including `BB_PROVIDER_BRIDGE_RECORD_DIR` — leaks into nanocodex, and a
 * recorded child that is itself bb-aware starts recording too.
 */
export function buildChildEnv(spec: RunSpec): NodeJS.ProcessEnv {
  return {
    ...withoutBridgeRuntimeEnv(sanitizeInheritedChildProcessEnv({ env: process.env })),
    ...spec.envVars,
  };
}

/**
 * Map bb's execution options onto a `RunSpec`, minus the prompt.
 *
 * The permission tuple is a discriminated union and only `permissionMode:
 * "full"` is declared, so there is nothing to map: nanocodex executes
 * everything unsandboxed and asks for nothing, which is exactly what `full`
 * means and is why the declaration offers no other mode.
 *
 * `reasoningLevel` maps 1:1 onto `--thinking` for the six declared levels;
 * `ultracode` and `ultra` are undeclared and, if one ever arrives, the flag is
 * omitted rather than guessed.
 *
 * `launch` and `features` are a deviation from the sketch's four-field
 * signature: the resolved CLI path and the feature pins come from
 * `providerOptions` and the session owns that lookup, so they arrive here
 * already decided.
 */
export function toRunSpec(args: {
  options: BridgeExecutionOptions;
  cwd: string;
  prompt: string;
  instructions: string | null;
  launch: { command: string; argsPrefix: readonly string[] };
  features: RunFeatures;
}): RunSpec {
  const { options } = args;
  const reasoningLevel = options.reasoningLevel;
  const thinking =
    reasoningLevel !== undefined &&
    (NANOCODEX_REASONING_LEVELS as readonly string[]).includes(reasoningLevel)
      ? reasoningLevel
      : null;
  return {
    command: args.launch.command,
    argsPrefix: args.launch.argsPrefix,
    cwd: args.cwd,
    prompt: args.prompt,
    instructions: args.instructions,
    model: options.model ?? null,
    thinking,
    serviceTier: options.serviceTier ?? null,
    envVars: options.envVars ?? {},
    features: args.features,
  };
}

/** @internal exported for tests. */
export function readBoundedStdout(
  stdout: NonNullable<ChildProcess["stdout"]>,
  maxLineBytes: number,
  onLine: (line: string) => void,
): void {
  readBoundedLines({
    input: stdout,
    maxLineBytes,
    onLine,
    onOverflow: () => {},
  });
}
