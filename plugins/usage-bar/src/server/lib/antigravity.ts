import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  experimental_hostToolchain as toolchain,
  experimental_spawnHostProcess as spawn,
} from "@get-bb/plugin-sdk/process";
import { z } from "zod";
import {
  byWindowLength,
  type MenuAccount,
  type MenuProvider,
  type MenuWindow,
  percent,
  WEEK_MINUTES,
} from "./pool.ts";

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
/** The longest a background check waits after agy answered that it is absent or signed out. */
const QUIET_MAX_MS = 60 * 60_000;
/**
 * agy takes 3 to 9 s to answer `/usage`. Nothing waits this long: Refresh waits
 * one 15 s poll at most, and a later answer is drawn when it lands.
 */
const TIMEOUT_MS = 30_000;
/** How long agy gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 1_000;
/** How long a descendant may hold agy's pipes after agy exits before the read settles anyway. */
const DRAIN_MS = 500;
/** A signed-out CLI prints this on stderr, then waits for a browser sign-in. */
const SIGNED_OUT = "Authentication required";
/** What a signed-out agy runs to open its sign-in page: `open` on macOS, the rest on Linux. */
const BROWSER_OPENERS = ["open", "xdg-open", "x-www-browser", "www-browser"];
/**
 * agy reads only `true` here: with `1` it still updated itself. Each run would
 * otherwise start a background update of the binary bb's Antigravity agent runs.
 */
const NO_AUTO_UPDATE = { AGY_CLI_DISABLE_AUTO_UPDATE: "true" };

/**
 * The server environment agy may see. `SSH_*` would make agy skip the system
 * keyring and read as signed out, and `BROWSER` names a browser to open, so
 * neither is passed; nor are bb's own variables.
 */
const ENV_KEYS = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TMPDIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
]);
const ENV_PREFIXES = ["LC_", "XDG_", "AGY_", "GEMINI_", "GOOGLE_"];

function childEnv(path: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_KEYS.has(key) || ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
      env[key] = value;
  }
  return { ...env, PATH: path, ...NO_AUTO_UPDATE };
}

/** agy's window ids. A Map, because `window` is the CLI's text. */
const WINDOWS = new Map([
  ["5h", { label: "session", minutes: 300 }],
  ["daily", { label: "daily", minutes: 1440 }],
  ["weekly", { label: "weekly", minutes: WEEK_MINUTES }],
]);

const bucketSchema = z.object({
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

/**
 * Whether a run may have spent quota: it ran a turn, left a conversation, or
 * answered something other than the `/usage` command. Read loosely, so an odd
 * field type (such as `"command": null`) reads as unsafe rather than failed.
 */
function unsafeRun(body: Record<string, unknown>): boolean {
  if ((body.num_turns ?? 0) !== 0 || (body.conversation_id ?? "") !== "") return true;
  const command = body.command;
  // An error envelope has no command; a successful one must name `usage`.
  if (command === undefined || command === null) return body.status === "SUCCESS";
  return typeof command !== "object" || (command as { name?: unknown }).name !== "usage";
}

/** `agy -p /usage --output-format json` as menu windows, session before weekly in each group. */
export function parseAntigravityUsage(body: unknown): ParsedUsage {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { kind: "failed" };
  if (unsafeRun(body as Record<string, unknown>)) return { kind: "unsafe" };
  const parsed = usageSchema.safeParse(body);
  if (!parsed.success) return { kind: "failed" };
  const windows = (parsed.data.command.data.groups ?? []).flatMap((group) =>
    (group.buckets ?? [])
      .map((bucket): MenuWindow => {
        const known = WINDOWS.get(bucket.window ?? "");
        return {
          label: `${groupLabel(group.name)} ${known?.label ?? bucket.name}`,
          usedPercent: percent(1 - (bucket.remaining_fraction ?? 0)),
          resetAt: resetAt(bucket.reset_time),
          windowMinutes: known?.minutes ?? null,
          // Every group's limits stop that group's models, so all count toward the menu bar.
          model: null,
        };
      })
      .sort(byWindowLength),
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

/**
 * One agy run, settled by `deadline` plus at most KILL_GRACE_MS + DRAIN_MS even
 * when agy ignores SIGTERM or a descendant keeps its pipes open.
 */
function run(
  binary: string,
  args: string[],
  signal: AbortSignal,
  deadline: number,
  options: { path?: string; cwd: string },
): Promise<Run> {
  if (signal.aborted)
    return Promise.resolve({ code: null, stdout: "", signedOut: false, timedOut: false });
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      env: childEnv(options.path ?? process.env.PATH),
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let signedOut = false;
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, act: () => void) => timers.push(setTimeout(act, Math.max(0, ms)));
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, stdout, signedOut, timedOut });
    };
    let stopping = false;
    function stop() {
      if (stopping || settled) return;
      stopping = true;
      child.kill("SIGTERM");
      later(KILL_GRACE_MS, () => {
        child.kill("SIGKILL");
        later(DRAIN_MS, () => settle(exitCode));
      });
    }
    later(deadline - Date.now(), () => {
      timedOut = true;
      stop();
    });
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
    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));
    child.on("exit", (code) => {
      exitCode = code;
      later(DRAIN_MS, () => settle(code));
    });
  });
}

/**
 * A signed-out agy opens its sign-in page with `open` or `xdg-open` before it
 * prints the URL, which would pop a browser tab on every read. Each read puts
 * no-op openers first on PATH, in a private directory it also runs agy in and
 * removes afterwards. (Setting SSH_CONNECTION also stops the browser, but then
 * agy skips the system keyring and reads as signed out.)
 */
async function withoutBrowser<A>(read: (dir: string, path: string) => Promise<A>): Promise<A> {
  const dir = await mkdtemp(join(tmpdir(), "bb-usage-bar-agy-"));
  try {
    await Promise.all(
      BROWSER_OPENERS.map((name) =>
        writeFile(join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
      ),
    );
    return await read(dir, [dir, process.env.PATH].filter(Boolean).join(delimiter));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Asked on every read: `agy` is often a version manager's shim (mise links it to
 * `mise` itself), so nothing on disk shows when the real binary changes.
 */
async function supportedAgy(binary: string, signal: AbortSignal, deadline: number) {
  // `--version` signs nothing in, so it needs no browser guard.
  const version = await run(binary, ["--version"], signal, deadline, { cwd: tmpdir() });
  if (version.timedOut || signal.aborted) return null;
  return version.code === 0 && supportedVersion(version.stdout);
}

/** One bounded `agy` read on the machine running the bb server. */
export async function probeAntigravity(
  signal: AbortSignal,
  findAgy: () => string | null = () => toolchain.resolve("agy"),
  timeoutMs = TIMEOUT_MS,
): Promise<AntigravityProbe> {
  if (signal.aborted) return { status: "failed" };
  const binary = findAgy();
  if (binary === null) return { status: "absent" };
  const deadline = Date.now() + timeoutMs;
  const supported = await supportedAgy(binary, signal, deadline);
  if (supported === null || signal.aborted) return { status: "failed" };
  // An older CLI would send "/usage" to the model as a prompt and spend a turn.
  if (!supported) return { status: "absent" };
  return withoutBrowser(async (cwd, path) => {
    const usage = await run(
      binary,
      ["-p", "/usage", "--output-format", "json", "--log-file", devNull],
      signal,
      deadline,
      { path, cwd },
    );
    if (usage.signedOut) return { status: "signed-out" };
    if (usage.timedOut || signal.aborted) return { status: "failed" };
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

const ANTIGRAVITY_ACCOUNT_ID = "antigravity";
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

/**
 * The menu's Antigravity provider, or null when agy is absent, signed out, or unsafe.
 * `onUpdate` hears the result of a read this call starts, including one that
 * finishes in the background after a poll returned.
 */
export type AntigravityReader = (
  signal: AbortSignal,
  refresh: boolean,
  onUpdate?: (provider: MenuProvider | null) => void,
) => Promise<MenuProvider | null>;

/**
 * Reads at most every 5 minutes, failures included. A poll returns the last
 * reading at once and refreshes it in the background, so a slow or signed-out
 * CLI never delays Codex and Claude. Refresh waits for a fresh read. A failed
 * read keeps the last reading, marked stale, so the menu does not flicker; only
 * a definite answer (absent or signed out) removes the item. Each definite
 * answer in a row doubles the wait before the next background check, up to an
 * hour; Refresh always checks.
 */
export function createAntigravityReader(
  probe: (signal: AbortSignal) => Promise<AntigravityProbe> = probeAntigravity,
  now: () => number = Date.now,
  log: Pick<Console, "warn" | "debug"> = { warn: () => {}, debug: () => {} },
): AntigravityReader {
  let current: MenuProvider | null = null;
  let at: number | null = null;
  let pending: Promise<void> | null = null;
  let disabled = false;
  /** Absent or signed-out answers in a row. */
  let misses = 0;

  /** Keep the last reading, dimmed and labelled, rather than flicker the item away. */
  const stale = () => {
    if (current !== null && current.error !== STALE) current = { ...current, error: STALE };
  };
  const apply = (result: AntigravityProbe) => {
    if (result.status === "absent" || result.status === "signed-out") {
      current = null;
      misses++;
      return;
    }
    if (result.status === "failed") return stale();
    const parsed = parseAntigravityUsage(result.body);
    if (parsed.kind === "unsafe") {
      // Retrying could spend a turn every 5 minutes. Stay off until the plugin reloads.
      disabled = true;
      current = null;
      log.warn("usage-bar: agy did not answer /usage as a command; Antigravity quota is off.");
    } else if (parsed.kind === "ok") {
      misses = 0;
      current = provider(parsed.windows, now());
    } else {
      stale();
    }
  };

  const settle = async (
    signal: AbortSignal,
    onUpdate?: (provider: MenuProvider | null) => void,
  ) => {
    try {
      const started = now();
      const result = await probe(signal).catch((): AntigravityProbe => ({ status: "failed" }));
      log.debug(`usage-bar: agy answered ${result.status} in ${now() - started} ms`);
      if (!signal.aborted) apply(result);
    } finally {
      at = now();
      pending = null;
    }
    if (!signal.aborted) onUpdate?.(current);
  };
  const start = (signal: AbortSignal, onUpdate?: (provider: MenuProvider | null) => void) =>
    (pending ??= settle(signal, onUpdate));
  /** 5 minutes, then 10, 20 and 40 after definite misses, then hourly. */
  const due = () =>
    at === null ||
    now() - at >= Math.min(FRESH_MS * 2 ** Math.max(0, Math.min(misses, 5) - 1), QUIET_MAX_MS);

  return async (signal, refresh, onUpdate) => {
    if (disabled) return null;
    if (refresh) await start(signal, onUpdate);
    else if (due()) void start(signal, onUpdate);
    return current;
  };
}
