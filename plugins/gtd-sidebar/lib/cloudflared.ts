import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLOUDFLARED_CANDIDATES = [
  "cloudflared",
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared",
  "/usr/bin/cloudflared",
] as const;

const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function parseTrycloudflareOrigin(text: string): string | null {
  const match = text.match(TRYCLOUDFLARE_URL);
  if (match === null || match[0] === undefined) return null;
  try {
    return new URL(match[0]).origin;
  } catch {
    return null;
  }
}

type ExecResult = { stdout: string; stderr: string; exitCode: number };

function exec(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 256 * 1024, signal },
      (error, stdout, stderr) => {
        const exitCode =
          error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          exitCode: error && (error as NodeJS.ErrnoException).code === "ABORT_ERR" ? 1 : exitCode,
        });
      },
    );
  });
}

export async function resolveCloudflaredPath(
  signal: AbortSignal,
  run: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<Pick<ExecResult, "exitCode">> = exec,
): Promise<string | null> {
  for (const candidate of CLOUDFLARED_CANDIDATES) {
    const result = await run(candidate, ["--version"], 5_000, signal);
    if (result.exitCode === 0) return candidate;
  }
  return null;
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const killer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2_000);
  killer.unref();
}

export interface TrycloudflareTunnel {
  origin: string;
  wait: Promise<number>;
  stop: () => void;
}

export async function startTrycloudflareTunnel(args: {
  bin: string;
  localOrigin: string;
  signal: AbortSignal;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}): Promise<TrycloudflareTunnel> {
  if (args.signal.aborted) throw new Error("aborted");
  const spawnFn = args.spawnImpl ?? spawn;
  // ~/.cloudflared/config.yml is for named tunnels and often ends in a
  // catch-all 404. Quick tunnels must not inherit it.
  const configDir = await mkdtemp(join(tmpdir(), "gtd-cloudflared-"));
  const configPath = join(configDir, "config.yml");
  await writeFile(configPath, "# gtd-sidebar webhook quick tunnel\n", "utf8");
  const child = spawnFn(
    args.bin,
    ["tunnel", "--no-autoupdate", "--config", configPath, "--url", args.localOrigin],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const wait = new Promise<number>((resolve) => {
    child.once("exit", (code, signal) => {
      void rm(configDir, { recursive: true, force: true });
      if (typeof code === "number") resolve(code);
      else resolve(signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1);
    });
    child.once("error", () => {
      void rm(configDir, { recursive: true, force: true });
      resolve(1);
    });
  });

  const stop = () => stopChild(child);
  args.signal.addEventListener("abort", stop, { once: true });

  let origin: string | null = null;
  let log = "";
  const take = (chunk: string) => {
    log += chunk;
    if (log.length > 32_768) log = log.slice(-16_384);
    if (origin === null) origin = parseTrycloudflareOrigin(chunk);
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  const timeoutMs = args.timeoutMs ?? 45_000;
  const found = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      args.signal.removeEventListener("abort", onAbort);
      child.off("exit", onExit);
      fn();
    };
    const onAbort = () =>
      finish(() => {
        stop();
        reject(new Error("aborted"));
      });
    const onExit = (code: number | null) =>
      finish(() => {
        reject(
          new Error(
            `cloudflared exited ${code ?? 1} before publishing a URL${log.trim().length > 0 ? `: ${log.trim()}` : ""}`,
          ),
        );
      });
    const timer = setTimeout(() => {
      finish(() => {
        stop();
        reject(new Error(`cloudflared did not print a trycloudflare URL within ${timeoutMs}ms`));
      });
    }, timeoutMs);
    const onData = (chunk: string) => {
      take(chunk);
      const foundOrigin = origin;
      if (foundOrigin !== null) finish(() => resolve(foundOrigin));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
    args.signal.addEventListener("abort", onAbort, { once: true });
    const already = origin;
    if (already !== null) finish(() => resolve(already));
  });

  return { origin: found, wait, stop };
}
