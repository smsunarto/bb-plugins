#!/usr/bin/env bun
/**
 * Screenshot an agent-browser page as a phone shows it: the device's viewport,
 * safe-area insets, and touch input, framed in Apple's bezel, whose mask hides
 * what the display's rounded corners and Dynamic Island hide.
 *
 *   bun scripts/phone-shot.ts devices
 *   bun scripts/phone-shot.ts start iphone-17-pro-max --session <id> [--no-insets] [--minutes 30]
 *   bun scripts/phone-shot.ts shot --session <id> --out /tmp/drawer
 *   bun scripts/phone-shot.ts stop --session <id>
 *
 * `start` emulates the phone on the session's current page; interact with
 * agent-browser as usual, then `shot` writes <out>.png and <out>-framed.png.
 * Chrome keeps one emulation state per page and clears all of it when a
 * DevTools session that set any of it detaches. So `start` leaves a holder
 * process attached for the whole run (until `stop`, the time limit, or the
 * page closing), and `shot` only reads and captures. A reload or navigation
 * keeps the emulation; a new tab does not.
 *
 * frames-cli (github.com/viticci/frames-cli) and its Apple Frames assets are
 * downloaded once, at a pinned commit, into ~/.cache/bb-plugins/phone-shot.
 * They need python3 with Pillow.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type Insets = { top: number; right: number; bottom: number; left: number };
export type PhoneDevice = {
  viewport: { width: number; height: number; dpr: number };
  insets: Insets;
  frame: string;
};

/** Portrait viewports whose captures match a frames-cli bezel exactly. */
export const DEVICES: Record<string, PhoneDevice> = {
  "iphone-17-pro-max": {
    viewport: { width: 440, height: 956, dpr: 3 },
    insets: { top: 62, right: 0, bottom: 34, left: 0 },
    frame: "iPhone 17 Pro Max Portrait",
  },
  "iphone-17-pro": {
    viewport: { width: 402, height: 874, dpr: 3 },
    insets: { top: 62, right: 0, bottom: 34, left: 0 },
    frame: "iPhone 17 Pro Portrait",
  },
  "iphone-16": {
    viewport: { width: 393, height: 852, dpr: 3 },
    insets: { top: 59, right: 0, bottom: 34, left: 0 },
    frame: "iPhone 16 Portrait",
  },
};

const FRAMES_REPO = "https://github.com/viticci/frames-cli.git";
const FRAMES_COMMIT = "769cfe374c68c9af95c290d4e28a54cca02106da";
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

export type Args = {
  command: "devices" | "start" | "shot" | "stop" | "hold";
  device?: string;
  session?: string;
  out?: string;
  insets: boolean;
  minutes: number;
};

const COMMANDS = new Set(["devices", "start", "shot", "stop", "hold"]);

export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.has(command)) throw new Error(usage());
  const args: Args = { command: command as Args["command"], insets: true, minutes: 30 };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === "--session") args.session = rest[++i];
    else if (flag === "--out") args.out = rest[++i];
    else if (flag === "--no-insets") args.insets = false;
    else if (flag === "--minutes") args.minutes = Number(rest[++i]);
    else if (!flag.startsWith("--") && !args.device) args.device = flag;
    else throw new Error(`Unknown argument: ${flag}\n\n${usage()}`);
  }
  return validate(args);
}

function validate(args: Args): Args {
  if (args.command === "devices") return args;
  if (!args.session) throw new Error(`${args.command} needs --session <agent-browser session>`);
  if (args.command === "start" || args.command === "hold") {
    args.device ??= "iphone-17-pro-max";
    if (!DEVICES[args.device]) {
      throw new Error(`Unknown device ${args.device}. Known: ${Object.keys(DEVICES).join(", ")}`);
    }
    if (!(args.minutes > 0)) throw new Error("--minutes must be a positive number");
  }
  if (args.command === "shot" && !args.out) throw new Error("shot needs --out <path without .png>");
  return args;
}

function usage(): string {
  return [
    "Usage:",
    "  bun scripts/phone-shot.ts devices",
    "  bun scripts/phone-shot.ts start <device> --session <id> [--no-insets] [--minutes 30]",
    "  bun scripts/phone-shot.ts shot --session <id> --out <path without .png>",
    "  bun scripts/phone-shot.ts stop --session <id>",
  ].join("\n");
}

function run(cmd: string[], env?: Record<string, string>): string {
  const result = Bun.spawnSync(cmd, { env: { ...process.env, ...env }, stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${result.exitCode}):\n${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function browser(session: string, ...cmd: string[]): string {
  // agent-browser prints a Chrome-version warning before some results.
  const lines = run(["agent-browser", "--session", session, ...cmd]).split("\n");
  return lines
    .filter((line) => !line.startsWith("⚠"))
    .join("\n")
    .trim();
}

/** A minimal DevTools Protocol client for one page target. */
async function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((done, fail) => {
    ws.addEventListener("open", () => done(), { once: true });
    ws.addEventListener("error", () => fail(new Error(`Cannot open ${wsUrl}`)), { once: true });
  });
  let nextId = 0;
  const pending = new Map<number, { done: (v: any) => void; fail: (e: Error) => void }>();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.fail(new Error(`${message.error.message} (${message.error.code})`));
    else waiter.done(message.result);
  });
  return {
    send(method: string, params: object = {}): Promise<any> {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((done, fail) => pending.set(id, { done, fail }));
    },
    close: () => ws.close(),
    onClose: (listener: () => void) => ws.addEventListener("close", listener),
  };
}

async function pageTarget(session: string): Promise<string> {
  const browserWs = browser(session, "get", "cdp-url");
  const pageUrl = browser(session, "get", "url");
  const http = browserWs.replace(/^ws/, "http").replace(/\/devtools\/browser\/.*$/, "");
  const targets: Array<{ type: string; url: string; webSocketDebuggerUrl: string }> = await (
    await fetch(`${http}/json/list`)
  ).json();
  const page = targets.find((t) => t.type === "page" && t.url === pageUrl);
  if (!page) throw new Error(`No page target at ${pageUrl} in session ${session}`);
  return page.webSocketDebuggerUrl;
}

function cacheRoot(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "bb-plugins", "phone-shot");
}

/** frames-cli at the pinned commit and the asset pack that commit names. */
function ensureFrames(): { script: string; assets: string; env: Record<string, string> } {
  const root = cacheRoot();
  const repo = join(root, `frames-cli-${FRAMES_COMMIT.slice(0, 12)}`);
  const script = join(repo, "frames");
  if (!existsSync(script)) {
    const staging = `${repo}.partial`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    run(["git", "-C", staging, "init", "-q"]);
    run(["git", "-C", staging, "fetch", "-q", "--depth", "1", FRAMES_REPO, FRAMES_COMMIT]);
    run(["git", "-C", staging, "checkout", "-q", "FETCH_HEAD"]);
    renameSync(staging, repo);
  }
  const assetsUrl = readFileSync(script, "utf8").match(/^ASSETS_URL = "(.+)"$/m)?.[1];
  if (!assetsUrl) throw new Error(`No ASSETS_URL in ${script}`);
  const assetsRoot = join(root, `assets-${basename(assetsUrl, ".zip")}`);
  const assets = join(assetsRoot, "Frames");
  if (!existsSync(join(assets, "NewFrames.json"))) {
    const staging = `${assetsRoot}.partial`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const zip = join(staging, "assets.zip");
    console.error(`phone-shot: downloading Apple Frames assets (~50 MB) to ${assetsRoot}`);
    run(["curl", "--location", "--fail", "--silent", "--show-error", "-o", zip, assetsUrl]);
    run(["python3", "-I", "-m", "zipfile", "-e", zip, staging]);
    rmSync(zip);
    renameSync(staging, assetsRoot);
  }
  if (Bun.spawnSync(["python3", "-c", "import PIL"]).exitCode !== 0) {
    throw new Error("frames-cli needs Pillow: python3 -m pip install --user Pillow");
  }
  // Keep frames-cli's config and data inside the cache.
  return { script, assets, env: { XDG_CONFIG_HOME: root, XDG_DATA_HOME: root } };
}

type HolderState = { pid: number; port: number; device: string; insets: Insets; expires: string };

function holderPath(session: string): string {
  return join(cacheRoot(), "holders", `${session.replace(/[^\w-]/g, "_")}.json`);
}

function readHolder(session: string): HolderState | undefined {
  const path = holderPath(session);
  if (!existsSync(path)) return undefined;
  const state = JSON.parse(readFileSync(path, "utf8")) as HolderState;
  try {
    process.kill(state.pid, 0);
    return state;
  } catch {
    rmSync(path, { force: true });
    return undefined;
  }
}

async function stopHolder(session: string): Promise<boolean> {
  const state = readHolder(session);
  if (!state) return false;
  process.kill(state.pid, "SIGTERM");
  for (let i = 0; i < 50 && readHolder(session); i++) await Bun.sleep(100);
  return true;
}

/** Runs detached for the whole emulation; its DevTools session owns the overrides. */
async function hold(args: Args): Promise<void> {
  const device = DEVICES[args.device!]!;
  const insets = args.insets ? device.insets : NO_INSETS;
  const path = holderPath(args.session!);
  const cdp = await connect(await pageTarget(args.session!));
  const exit = () => {
    try {
      const state = JSON.parse(readFileSync(path, "utf8")) as HolderState;
      if (state.pid === process.pid) rmSync(path, { force: true });
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", exit);
  process.on("SIGINT", exit);
  cdp.onClose(exit);
  setTimeout(exit, args.minutes * 60_000);
  const { width, height, dpr } = device.viewport;
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: dpr,
    mobile: true,
  });
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  // Only the session that owns the emulation captures at the device scale: another
  // session captures at 1x, and asking it to scale resets the page's pixel ratio.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      try {
        return new Response(await capture(cdp, device));
      } catch (error) {
        return new Response((error as Error).message, { status: 409 });
      }
    },
  });
  mkdirSync(dirname(path), { recursive: true });
  const expires = new Date(Date.now() + args.minutes * 60_000).toISOString();
  const state: HolderState = {
    pid: process.pid,
    port: server.port!,
    device: args.device!,
    insets,
    expires,
  };
  writeFileSync(path, JSON.stringify(state));
}

async function start(args: Args): Promise<object> {
  await stopHolder(args.session!);
  const child = spawn(
    process.execPath,
    [
      import.meta.path,
      "hold",
      args.device!,
      "--session",
      args.session!,
      "--minutes",
      String(args.minutes),
      ...(args.insets ? [] : ["--no-insets"]),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 100; i++) {
    const state = readHolder(args.session!);
    if (state?.pid === child.pid) {
      const [width, height, dpr] = JSON.parse(
        JSON.parse(
          browser(
            args.session!,
            "eval",
            "JSON.stringify([innerWidth, innerHeight, devicePixelRatio])",
          ),
        ),
      ) as number[];
      return { ...state, viewport: `${width}×${height}@${dpr}` };
    }
    if (child.exitCode !== null) break;
    await Bun.sleep(100);
  }
  throw new Error(`phone-shot holder did not start for session ${args.session}`);
}

async function capture(cdp: Awaited<ReturnType<typeof connect>>, device: PhoneDevice) {
  const { width, height, dpr } = device.viewport;
  const { result } = await cdp.send("Runtime.evaluate", {
    expression:
      "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r([innerWidth, innerHeight]))))",
    awaitPromise: true,
    returnByValue: true,
  });
  const [pageWidth, pageHeight] = result.value as number[];
  if (pageWidth !== width || pageHeight !== height) {
    throw new Error(`Page is ${pageWidth}×${pageHeight}, not ${width}×${height}`);
  }
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const png = Buffer.from(data, "base64");
  const size = [png.readUInt32BE(16), png.readUInt32BE(20)];
  if (size[0] !== width * dpr || size[1] !== height * dpr) {
    throw new Error(`Captured ${size.join("×")}, not ${width * dpr}×${height * dpr}`);
  }
  return png;
}

async function shot(args: Args): Promise<object> {
  const state = readHolder(args.session!);
  if (!state) {
    throw new Error(
      `No phone emulation on session ${args.session}. Run: bun scripts/phone-shot.ts start <device> --session ${args.session}`,
    );
  }
  const device = DEVICES[state.device]!;
  const out = resolve(args.out!);
  mkdirSync(dirname(out), { recursive: true });
  const response = await fetch(`http://127.0.0.1:${state.port}/capture`);
  if (!response.ok) throw new Error(`Capture failed: ${await response.text()}`);
  writeFileSync(`${out}.png`, Buffer.from(await response.arrayBuffer()));

  const frames = ensureFrames();
  const report = run(
    [
      "python3",
      frames.script,
      "--json",
      "--assets",
      frames.assets,
      "frame",
      "--device",
      device.frame,
      "--output",
      dirname(out),
      `${out}.png`,
    ],
    frames.env,
  );
  const produced = join(dirname(out), `${basename(out)}_framed.png`);
  if (!existsSync(produced)) throw new Error(`frames-cli did not write ${produced}:\n${report}`);
  renameSync(produced, `${out}-framed.png`);
  return {
    device: state.device,
    insets: state.insets,
    raw: `${out}.png`,
    framed: `${out}-framed.png`,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "devices") {
    for (const [id, d] of Object.entries(DEVICES)) {
      const { width, height, dpr } = d.viewport;
      console.log(
        `${id}  ${width}×${height}@${dpr}  insets top ${d.insets.top} bottom ${d.insets.bottom}  frame "${d.frame}"`,
      );
    }
    return;
  }
  if (args.command === "hold") return hold(args);
  if (args.command === "stop") {
    const stopped = await stopHolder(args.session!);
    console.log(
      stopped
        ? `Stopped phone emulation on ${args.session}`
        : `No phone emulation on ${args.session}`,
    );
    return;
  }
  const result = args.command === "start" ? await start(args) : await shot(args);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
