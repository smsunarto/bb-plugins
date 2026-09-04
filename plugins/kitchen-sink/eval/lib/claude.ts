import { capture } from "./proc.ts";

export type ClaudeResult = {
  response: string;
  timedOut: boolean;
  ok: boolean;
  turns: number;
  costUsd: number;
  durationMs: number;
  stopReason: string;
  stderr: string;
};

export type ClaudeRequest = {
  cwd: string;
  model: string;
  prompt: string;
  systemPromptAppendix: string;
  maxTurns: number;
  timeoutMs: number;
};

type HeadlessJson = {
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  subtype?: string;
};

/**
 * `--safe-mode` is what keeps the candidate blind: it drops this machine's
 * CLAUDE.md, skills, plugins, and hooks while leaving auth and the appended
 * prompt under test in place.
 */
export async function runClaude(request: ClaudeRequest): Promise<ClaudeResult> {
  const started = Date.now();
  const captured = await capture(
    "claude",
    [
      "-p",
      "--safe-mode",
      "--model",
      request.model,
      "--output-format",
      "json",
      "--no-session-persistence",
      "--dangerously-skip-permissions",
      "--max-turns",
      String(request.maxTurns),
      "--append-system-prompt",
      request.systemPromptAppendix,
      request.prompt,
    ],
    { cwd: request.cwd, timeoutMs: request.timeoutMs },
  );

  const { stdout, stderr } = captured;
  const durationMs = Date.now() - started;
  if (captured.timedOut) {
    return {
      response: "",
      timedOut: true,
      ok: false,
      turns: 0,
      costUsd: 0,
      durationMs,
      stopReason: "timeout",
      stderr: stderr.slice(0, 2000),
    };
  }

  let parsed: HeadlessJson | null = null;
  try {
    parsed = JSON.parse(stdout) as HeadlessJson;
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    return {
      response: "",
      timedOut: false,
      ok: false,
      turns: 0,
      costUsd: 0,
      durationMs,
      stopReason: "unparseable",
      stderr: `${stderr}\n${stdout}`.slice(0, 2000),
    };
  }
  return {
    response: parsed.result ?? "",
    timedOut: false,
    ok: parsed.is_error !== true,
    turns: parsed.num_turns ?? 0,
    costUsd: parsed.total_cost_usd ?? 0,
    durationMs,
    stopReason: parsed.subtype ?? "unknown",
    stderr: stderr.slice(0, 2000),
  };
}
