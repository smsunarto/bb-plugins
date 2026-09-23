import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { CompleteInstancePlan, LauncherTarget } from "./model.ts";
import { BB_ROUTING_KEYS } from "./routing.ts";

export async function probeApp(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function openApp(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => {});
  child.unref();
}

export function leaseKeyFor(target: LauncherTarget): string {
  return `${target.appPort}-${target.serverPort}-${target.hostDaemonPort}`;
}

export function logPath(target: LauncherTarget, kind: "dev" | "desktop" | "launcher"): string {
  if (kind === "dev") {
    return target.devLog;
  }
  if (kind === "desktop") {
    return target.desktopLog;
  }
  return target.launcherLog;
}

export function writeShim(plan: CompleteInstancePlan, binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  // An owned shim clears the bb routing keys so the CLI finds its own instance
  // through the checkout. A runtime shares that checkout with its source, so
  // clearing them would route it to the source's bb. It sets them instead.
  const content = shimSource(
    plan.checkoutPath,
    plan.source === "runtime"
      ? { serverUrl: plan.target.serverUrl, hostDaemonPort: plan.target.hostDaemonPort }
      : null,
  );
  const temporary = `${plan.shimPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o755 });
  renameSync(temporary, plan.shimPath);
  chmodSync(plan.shimPath, 0o755);
}

function shimSource(
  checkoutPath: string,
  runtime: { serverUrl: string; hostDaemonPort: number } | null,
): string {
  const routing =
    runtime === null
      ? ""
      : `environment.BB_SERVER_URL = ${JSON.stringify(runtime.serverUrl)};
environment.BB_HOST_DAEMON_PORT = ${JSON.stringify(String(runtime.hostDaemonPort))};
`;
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const checkout = ${JSON.stringify(checkoutPath)};
const caller = process.cwd();
const args = process.argv.slice(2);
if (
  args[0] === "plugin" &&
  ["build", "dev", "migrate", "types"].includes(args[1] ?? "")
) {
  if (args.length < 3 || args[2]?.startsWith("-")) {
    args.splice(2, 0, caller);
  } else if (args[2] === "." || args[2]?.startsWith("./") || args[2]?.startsWith("../")) {
    args[2] = resolve(caller, args[2]);
  }
}
const environment = { ...process.env };
for (const key of ${JSON.stringify(BB_ROUTING_KEYS)}) {
  delete environment[key];
}
${routing}const child = spawn("pnpm", ["-C", checkout, "--silent", "bb:dev", ...args], {
  cwd: caller,
  env: environment,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode =
    signal === null
      ? (code ?? 1)
      : signal === "SIGINT"
        ? 130
        : signal === "SIGTERM"
          ? 143
          : signal === "SIGHUP"
            ? 129
            : 128;
});
`;
}
