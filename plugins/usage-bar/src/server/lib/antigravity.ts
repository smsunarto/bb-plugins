import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  experimental_hostToolchain as toolchain,
  experimental_spawnHostProcess as spawn,
} from "@get-bb/plugin-sdk/process";
import { z } from "zod";
import type { MenuAccount, MenuProvider, MenuWindow } from "./pool.ts";

/**
 * Antigravity quota from the `agy` CLI, the binary bb's Antigravity ACP agent runs.
 * Since agy 1.1.11, `agy -p /usage --output-format json` answers from the CLI
 * without starting an agent turn, spending quota, or leaving a conversation behind
 * (agy changelog). The CLI reads its own sign-in, so this plugin never sees a token.
 * No such command reports the account's email or tier, so the card shows neither.
 */

/** 1.1.11 answers `/usage` in print mode; 1.1.12 also answers `/help`, so both are stable. */
const MIN_VERSION = [1, 1, 12] as const;
const FRESH_MS = 5 * 60_000;
/** Under the menu's 15 s poll, so a stuck CLI cannot hold up a Refresh. */
const TIMEOUT_MS = 10_000;
/** A signed-out CLI prints this on stderr, then waits for a browser sign-in. */
const SIGNED_OUT = "Authentication required";
/** What a signed-out agy runs to open its sign-in page: `open` on macOS, the rest on Linux. */
const BROWSER_OPENERS = ["open", "xdg-open", "x-www-browser", "www-browser"];

const WEEK_MINUTES = 10080;
const WINDOW_MINUTES: Record<string, number> = { "5h": 300, daily: 1440, weekly: WEEK_MINUTES };
const WINDOW_LABELS: Record<string, string> = { "5h": "session", daily: "daily", weekly: "weekly" };

const bucketSchema = z.object({
  id: z.string(),
  name: z.string(),
  window: z.string().optional(),
  // agy tags this `omitempty`, so an exhausted bucket (0 left) omits it.
  remaining_fraction: z.number().min(0).max(1).optional(),
  reset_time: z.string().optional(),
});

const usageSchema = z.object({
  status: z.literal("SUCCESS"),
  command: z.object({
    name: z.literal("usage"),
    data: z.object({
      groups: z
        .array(z.object({ name: z.string(), buckets: z.array(bucketSchema).optional() }))
        .optional(),
    }),
  }),
});

/** What one CLI run said. `failed` keeps the last reading; the others replace it. */
export type AntigravityProbe =
  | { status: "ok"; body: unknown }
  | { status: "absent" }
  | { status: "signed-out" }
  | { status: "failed" };

export type ParsedUsage =
  | { kind: "ok"; windows: MenuWindow[] }
  /** The CLI ran something other than the `/usage` command: possibly an agent turn. */
  | { kind: "unsafe" }
  | { kind: "failed" };

/** "Claude and GPT models" → "Claude/GPT", so the row fits the 310 pt menu beside its reset. */
function groupLabel(name: string): string {
  return (
    name
      .replace(/\s+models$/iu, "")
      .replace(/\s+and\s+/giu, "/")
      .trim() || name
  );
}

function resetAt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const at = Date.parse(value);
  // agy reports a bucket with no scheduled reset as the Unix epoch.
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** `agy -p /usage --output-format json` as menu windows, session before weekly in each group. */
export function parseAntigravityUsage(body: unknown): ParsedUsage {
  const envelope = z
    .object({
      status: z.string().optional(),
      conversation_id: z.string().optional(),
      num_turns: z.number().optional(),
      command: z.object({ name: z.string() }).optional(),
    })
    .safeParse(body);
  if (!envelope.success) return { kind: "failed" };
  // A run that is not the usage command, or that ran a turn, may have spent quota.
  const { status, conversation_id: conversation, num_turns: turns, command } = envelope.data;
  if ((turns ?? 0) !== 0 || (conversation ?? "") !== "") return { kind: "unsafe" };
  if (command === undefined ? status === "SUCCESS" : command.name !== "usage")
    return { kind: "unsafe" };
  const parsed = usageSchema.safeParse(body);
  if (!parsed.success) return { kind: "failed" };
  const windows = (parsed.data.command.data.groups ?? []).flatMap((group) =>
    (group.buckets ?? [])
      .map((bucket): MenuWindow => {
        const window = bucket.window ?? "";
        const remaining = bucket.remaining_fraction ?? 0;
        return {
          label: `${groupLabel(group.name)} ${WINDOW_LABELS[window] ?? bucket.name}`,
          usedPercent: Math.min(100, Math.max(0, Math.round((1 - remaining) * 10_000) / 100)),
          resetAt: resetAt(bucket.reset_time),
          windowMinutes: WINDOW_MINUTES[window] ?? null,
          // Every group's limits stop that group's models, so all count toward the menu bar.
          model: null,
        };
      })
      .sort(
        (left, right) =>
          (left.windowMinutes ?? Number.POSITIVE_INFINITY) -
          (right.windowMinutes ?? Number.POSITIVE_INFINITY),
      ),
  );
  return { kind: "ok", windows };
}

/** "1.5.17" → true when at least MIN_VERSION. Anything unparsable is too old. */
export function supportedVersion(output: string): boolean {
  const match = output.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/u);
  if (!match) return false;
  const version = match.slice(1, 4).map(Number);
  for (const [index, minimum] of MIN_VERSION.entries()) {
    const part = version[index]!;
    if (part !== minimum) return part > minimum;
  }
  return true;
}

interface Run {
  code: number | null;
  stdout: string;
  signedOut: boolean;
  timedOut: boolean;
}

function run(
  binary: string,
  args: string[],
  signal: AbortSignal,
  deadline: number,
  path: string | undefined,
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      // Background reads must not update the binary bb's agent runs.
      env: { ...process.env, PATH: path, AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let signedOut = false;
    let timedOut = false;
    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.max(0, deadline - Date.now()),
    );
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < 1_048_576) stdout += chunk;
    });
    // stderr can carry a sign-in URL. It is only matched, never logged or kept.
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (signedOut) return;
      stderr = (stderr + chunk).slice(-4096);
      if (stderr.includes(SIGNED_OUT)) {
        signedOut = true;
        stop();
      }
    });
    const settle = (code: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({ code, stdout, signedOut, timedOut });
    };
    child.on("error", () => settle(null));
    child.on("close", settle);
  });
}

/**
 * A signed-out agy opens its sign-in page with `open` or `xdg-open` before it
 * prints the URL, which would pop a browser tab on every read. Each read puts
 * no-op openers first on PATH, in a private directory it removes afterwards.
 * (Setting SSH_CONNECTION also stops the browser, but then agy skips the
 * system keyring and reads as signed out.)
 */
async function withoutBrowser<A>(read: (path: string) => Promise<A>): Promise<A> {
  const dir = await mkdtemp(join(tmpdir(), "bb-usage-bar-agy-"));
  try {
    await Promise.all(
      BROWSER_OPENERS.map((name) =>
        writeFile(join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
      ),
    );
    return await read([dir, process.env.PATH].filter(Boolean).join(delimiter));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One bounded `agy` read on the machine running the bb server. */
export async function probeAntigravity(
  signal: AbortSignal,
  findAgy: () => string | null = () => toolchain.resolve("agy"),
): Promise<AntigravityProbe> {
  const binary = findAgy();
  if (binary === null) return { status: "absent" };
  return withoutBrowser(async (path) => {
    const deadline = Date.now() + TIMEOUT_MS;
    const version = await run(binary, ["--version"], signal, deadline, path);
    if (version.timedOut || signal.aborted) return { status: "failed" };
    // An older CLI would send "/usage" to the model as a prompt and spend a turn.
    if (version.code !== 0 || !supportedVersion(version.stdout)) return { status: "absent" };
    const usage = await run(
      binary,
      ["-p", "/usage", "--output-format", "json", "--log-file", devNull],
      signal,
      deadline,
      path,
    );
    if (usage.signedOut) return { status: "signed-out" };
    // agy exits 2 when the sign-in has no account quota, as with a GEMINI_API_KEY.
    if (usage.code === 2) return { status: "absent" };
    if (usage.code !== 0) return { status: "failed" };
    try {
      return { status: "ok", body: JSON.parse(usage.stdout) };
    } catch {
      return { status: "failed" };
    }
  });
}

export const ANTIGRAVITY_ACCOUNT_ID = "antigravity";
const STALE = "Couldn't refresh Antigravity. Showing the last reading.";

function provider(windows: MenuWindow[], observedAt: number): MenuProvider {
  const account: MenuAccount = {
    id: ANTIGRAVITY_ACCOUNT_ID,
    identity: "Antigravity CLI",
    plan: null,
    status: "ready",
    current: true,
    lastUsedAt: null,
    observedAt,
    heldUntil: null,
    error: null,
    inFlight: 0,
    windows,
  };
  return { id: "antigravity", name: "Antigravity", accounts: [account] };
}

/** The menu's Antigravity provider, or null when agy is absent, signed out, or unsafe. */
export type AntigravityReader = (
  signal: AbortSignal,
  refresh: boolean,
) => Promise<MenuProvider | null>;

/**
 * Reads at most every 5 minutes, failures included. A poll returns the last
 * reading at once and refreshes it in the background, so a slow or signed-out
 * CLI never delays Codex and Claude. Refresh waits for a fresh read. A failed
 * read keeps the last reading, marked stale, so the menu does not flicker; only
 * a definite answer (absent or signed out) removes the item.
 */
export function createAntigravityReader(
  probe: (signal: AbortSignal) => Promise<AntigravityProbe> = probeAntigravity,
  now: () => number = Date.now,
  warn: (message: string) => void = () => {},
): AntigravityReader {
  let current: MenuProvider | null = null;
  let at: number | null = null;
  let pending: Promise<void> | null = null;
  let disabled = false;

  /** Keep the last reading, dimmed and labelled, rather than flicker the item away. */
  const stale = () => {
    if (current !== null && current.error !== STALE) current = { ...current, error: STALE };
  };
  const apply = (result: AntigravityProbe) => {
    if (result.status === "absent" || result.status === "signed-out") {
      current = null;
      return;
    }
    if (result.status === "failed") return stale();
    const parsed = parseAntigravityUsage(result.body);
    if (parsed.kind === "unsafe") {
      // Retrying could spend a turn every 5 minutes. Stay off until the plugin reloads.
      disabled = true;
      current = null;
      warn("usage-bar: agy did not answer /usage as a command; Antigravity quota is off.");
    } else if (parsed.kind === "ok") {
      current = provider(parsed.windows, now());
    } else {
      stale();
    }
  };

  const settle = async (signal: AbortSignal) => {
    try {
      const result = await probe(signal).catch((): AntigravityProbe => ({ status: "failed" }));
      if (!signal.aborted) apply(result);
    } finally {
      at = now();
      pending = null;
    }
  };
  const start = (signal: AbortSignal) => (pending ??= settle(signal));

  return async (signal, refresh) => {
    if (disabled) return null;
    if (refresh) await start(signal);
    else if (at === null || now() - at >= FRESH_MS) void start(signal);
    return disabled ? null : current;
  };
}
