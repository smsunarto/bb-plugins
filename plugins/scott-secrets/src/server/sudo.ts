import type { PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import {
  SUDO_REQUEST_RENDERER,
  sudoRequestResponseSchema,
  type SudoRequestPayload,
  type SudoRunResult,
} from "../shared/schema.ts";
import { displayCommand } from "../shared/command.ts";
import { clamp, cliError, threadTarget, type ServerContext, type ThreadTarget } from "./shared.ts";

/**
 * `bb secret sudo -- <argv…>`: the user approves the exact command, and the
 * host runs it with the password it holds in memory. The password is typed
 * once per cache window and is never returned, written, or put in argv.
 */

const LABEL_MAX = 80;
const HOST_CALL_SLACK_MS = 60_000;
const FORGET_TIMEOUT_MS = 15_000;

export interface SudoRequest {
  argv: string[];
  purpose: string | null;
  timeoutMs: number;
}

export function parseSudo(input: {
  passthrough: readonly string[];
  purpose: string | undefined;
  timeoutSeconds: number;
}): SudoRequest {
  if (input.passthrough.length === 0 || input.passthrough[0] === "") {
    cliError(
      "bb secret sudo needs a command after --.",
      "missing_command",
      "Write bb secret sudo --purpose 'why' -- pacman -Syu",
    );
  }
  if (input.passthrough.some((arg) => arg.includes("\0"))) {
    cliError("Command arguments must not contain NUL.", "invalid_command");
  }
  const purpose = input.purpose?.trim();
  if (purpose !== undefined && purpose.length === 0) {
    cliError("--purpose requires a non-empty description.", "invalid_purpose");
  }
  return {
    argv: [...input.passthrough],
    purpose: purpose ?? null,
    timeoutMs: input.timeoutSeconds * 1000,
  };
}

function formatResult(result: Extract<SudoRunResult, { outcome: "ran" }>): PluginCliResult {
  const notes: string[] = [];
  if (result.timedOut) notes.push("bb secret sudo: the command timed out and was terminated.");
  else if (result.signal)
    notes.push(`bb secret sudo: the command was terminated by ${result.signal}.`);
  if (result.truncated) notes.push("bb secret sudo: output was truncated at 4 MiB per stream.");
  const stderr = [result.stderr, ...notes.map((note) => `${note}\n`)].join("");
  return {
    exitCode: result.exitCode,
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(stderr ? { stderr } : {}),
  };
}

async function runOnHost(
  ctx: ServerContext,
  target: ThreadTarget,
  request: SudoRequest,
  cacheMinutes: number,
  password?: string,
): Promise<SudoRunResult> {
  return ctx.host.call(
    "sudoRun",
    {
      threadId: target.threadId,
      argv: request.argv,
      cwd: target.cwd,
      ...(password === undefined ? {} : { password }),
      cacheMs: cacheMinutes * 60_000,
      timeoutMs: request.timeoutMs,
    },
    { hostId: target.hostId, timeoutMs: request.timeoutMs + HOST_CALL_SLACK_MS },
  );
}

function finish(result: SudoRunResult): PluginCliResult {
  switch (result.outcome) {
    case "ran":
      return formatResult(result);
    case "needs_password":
      cliError("sudo has no password for this thread.", "sudo_needs_password");
    case "auth_failed":
      cliError(
        `sudo rejected the password; nothing ran and no password is cached (${clamp(result.detail, 200)}).`,
        "sudo_auth_failed",
        "Rerun the same command; the user will be asked to type the password again.",
      );
    case "unsupported":
      cliError(result.detail, "sudo_unsupported");
  }
}

/**
 * Within a thread's cache window the command runs without a form: the user
 * approved sudo for this thread when they typed the password. Otherwise the
 * form shows the command and asks for the password, which then covers this
 * thread for the rest of the window.
 */
export async function runSudo(
  ctx: ServerContext,
  request: SudoRequest,
  context: PluginCliContext,
): Promise<PluginCliResult> {
  const target = await threadTarget(ctx.bb, "sudo", context);
  const cacheMinutes = await ctx.sudoCacheMinutes();

  const cached = await runOnHost(ctx, target, request, cacheMinutes);
  if (cached.outcome !== "needs_password") return finish(cached);

  const shown = displayCommand(request.argv);
  const payload: SudoRequestPayload = {
    argv: request.argv,
    cwd: target.cwd,
    host: target.hostName,
    purpose: request.purpose,
    cacheMinutes,
  };
  const answer = await ctx.bb.ui.requestInput(
    {
      threadId: target.threadId,
      rendererId: SUDO_REQUEST_RENDERER,
      title: "Run with sudo",
      payload,
      presentation: {
        label: {
          pending: clamp(`Requesting sudo: ${shown}`, LABEL_MAX),
          completed: clamp(`Approved sudo: ${shown}`, LABEL_MAX),
        },
      },
      // The command only; the submitted value holds the password.
      describeSubmission: () => ({
        title: clamp(`Approved sudo: ${shown}`, 160),
        detail: [`\`${clamp(shown, 2000)}\``, `in \`${target.cwd}\` on ${target.hostName}`].join(
          "\n\n",
        ),
      }),
    },
    { signal: target.signal },
  );
  if (answer.outcome === "cancelled") {
    cliError(`sudo request denied (${answer.reason}).`, "sudo_request_denied");
  }
  const parsed = sudoRequestResponseSchema.safeParse(answer.value);
  if (!parsed.success) cliError("The sudo approval was malformed.", "unexpected_sudo_response");
  // A rejected password is never retried, so a stale one cannot walk the
  // account into a faillock lockout.
  return finish(await runOnHost(ctx, target, request, cacheMinutes, parsed.data.password));
}

export async function forgetSudo(
  ctx: ServerContext,
  context: PluginCliContext,
): Promise<PluginCliResult> {
  const target = await threadTarget(ctx.bb, "forget-sudo", context);
  const { forgotten } = await ctx.host.call(
    "sudoForget",
    { threadId: target.threadId },
    { hostId: target.hostId, timeoutMs: FORGET_TIMEOUT_MS },
  );
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ host: target.hostName, thread: target.threadId, forgotten })}\n`,
  };
}
