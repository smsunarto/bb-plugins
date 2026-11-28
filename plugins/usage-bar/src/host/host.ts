import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { experimental_spawnHostProcess as spawn } from "@get-bb/plugin-sdk/process";
import { createInterface } from "node:readline";
import {
  type ExperimentalHostRpcContext,
  type ExperimentalHostWorkerLease,
  experimental_defineHostEntry,
} from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { menuHostContract, menuHostSignals } from "../shared/host-contract.ts";
import { buildHelper } from "./helper.ts";

const BB_BUNDLE_ID = "dev.bb.desktop";
/** UsageBar.swift exits with this when another bb already draws the menu on this Mac. */
const LOCKED_EXIT = 3;
/** Wait before starting the helper again after it exits or fails to build. */
const RETRY_MS = 30_000;
/** How long dispose waits after SIGTERM before it sends SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** Messages the helper writes to stdout, one JSON object per line. */
const helperMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("menuOpened") }),
  z.object({ type: z.literal("refresh") }),
  z.object({ type: z.literal("openBb") }),
  z.object({ type: z.literal("quit") }),
]);

type Context = ExperimentalHostRpcContext<typeof menuHostSignals>;
/** Seams for tests; production uses the real build and process spawn. */
export type MenuHostDeps = {
  build?: typeof buildHelper;
  spawnHelper?: (
    binary: string,
    args: string[],
    signal: AbortSignal,
  ) => ChildProcessWithoutNullStreams;
  killGraceMs?: number;
};
type Helper = {
  child: ChildProcessWithoutNullStreams;
  /** Last line written per message type, so an unchanged menu is not redrawn. */
  written: Map<string, string>;
};

/**
 * Own this Mac's menu bar helper. The worker holds it for its whole lifetime: the
 * server pushes each menu through `render`, and the helper's commands come back
 * as signals. Quit from the menu stops the helper and releases the worker lease,
 * so the items stay hidden until the worker restarts. Disposing the worker stops
 * the helper too: SIGTERM, then SIGKILL after a grace period.
 */
export function createMenuHost(
  platform: NodeJS.Platform = process.platform,
  deps: MenuHostDeps = {},
) {
  const build = deps.build ?? buildHelper;
  const spawnHelper =
    deps.spawnHelper ??
    ((binary: string, args: string[], signal: AbortSignal) =>
      spawn(binary, args, { stdio: "pipe", signal }));
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  let helper: Helper | null = null;
  let starting: Promise<void> | null = null;
  let retryAt = 0;
  let quit = false;
  let needsConfiguration: string | null = null;
  let lease: ExperimentalHostWorkerLease | null = null;
  let disposed = false;

  function releaseLease(): Promise<void> {
    const current = lease;
    lease = null;
    return current ? current.dispose().catch(() => {}) : Promise.resolve();
  }

  /** SIGTERM, then SIGKILL if the helper is still running after the grace period. */
  function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, killGraceMs);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  async function start(context: Context): Promise<void> {
    const { binary, dir } = await build(context.lifecycle.signal);
    if (disposed) return;
    const child = spawnHelper(binary, [dir], context.lifecycle.signal);
    const current: Helper = { child, written: new Map() };
    // `close` always follows a spawn error, and a write after exit raises EPIPE.
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    createInterface({ input: child.stderr }).on("line", (line) => {
      console.warn(`usage-bar helper: ${line}`);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const parsed = helperMessageSchema.safeParse(message);
      if (!parsed.success) return;
      switch (parsed.data.type) {
        case "menuOpened":
        case "refresh":
          // The helper shows refreshing on its own, so always send the server's next value.
          if (parsed.data.type === "refresh") current.written.delete("refreshing");
          void context.experimental_emitSignal("menu", { type: parsed.data.type }).catch(() => {});
          break;
        case "openBb":
          spawn("open", ["-b", BB_BUNDLE_ID], { stdio: "ignore" }).on("error", () => {});
          break;
        case "quit":
          quit = true;
          child.kill();
          void releaseLease();
          break;
      }
    });
    child.once("close", (code) => {
      if (helper === current) helper = null;
      retryAt = Date.now() + RETRY_MS;
      if (!quit && code !== LOCKED_EXIT && !context.lifecycle.signal.aborted) {
        console.warn(`usage-bar: helper exited with code ${String(code)}`);
      }
    });
    helper = current;
  }

  function write(target: Helper, message: { type: string } & Record<string, unknown>) {
    const line = JSON.stringify(message);
    if (target.written.get(message.type) === line) return;
    target.written.set(message.type, line);
    target.child.stdin.write(`${line}\n`);
  }

  return experimental_defineHostEntry({
    contract: menuHostContract,
    experimental_signals: menuHostSignals,
    handlers: {
      async render({ snapshot, refreshing }, context) {
        if (platform !== "darwin") return { status: "unsupported" as const };
        if (quit || disposed) return { status: "ok" as const };
        // The helper outlives each call, so keep the worker for as long as bb runs.
        lease ??= context.experimental_retainWorker();
        if (needsConfiguration !== null) {
          return { status: "needs-configuration" as const, message: needsConfiguration };
        }
        if (helper === null && Date.now() >= retryAt) {
          starting ??= start(context).finally(() => {
            starting = null;
          });
          try {
            await starting;
          } catch (error) {
            if (error instanceof Error && error.name === "NeedsConfigurationError") {
              needsConfiguration = error.message;
              return { status: "needs-configuration" as const, message: needsConfiguration };
            }
            retryAt = Date.now() + RETRY_MS;
            throw error;
          }
        }
        if (helper !== null) {
          write(helper, { type: "snapshot", ...snapshot });
          write(helper, { type: "refreshing", value: refreshing });
        }
        return { status: "ok" as const };
      },
    },
    async dispose() {
      disposed = true;
      await starting?.catch(() => {});
      const current = helper;
      helper = null;
      if (current) await stopChild(current.child);
      await releaseLease();
    },
  });
}

export default createMenuHost();
