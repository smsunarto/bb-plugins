import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { buildHelper, nativeDir } from "./helper.ts";
import { createMenuState } from "./menu-state.ts";
import type { MenuSnapshot } from "./pool.ts";
import { POOL_PLUGIN_ID, createSourceReader } from "./sources.ts";

/** Reading the pool is a local store read; quota itself moves on proxied traffic. */
const POLL_MS = 15_000;
const BB_BUNDLE_ID = "dev.bb.desktop";

/** Messages the helper writes to stdout, one JSON object per line. */
const helperMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("menuOpened") }),
  z.object({ type: z.literal("refresh") }),
  z.object({ type: z.literal("openBb") }),
  z.object({ type: z.literal("quit") }),
]);

/** Messages the helper reads from stdin. */
type HelperInput = ({ type: "snapshot" } & MenuSnapshot) | { type: "refreshing"; value: boolean };

/** Unlike `once(signal, "abort")`, this also settles for an already-aborted signal. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Own one helper process for the lifetime of the background service: feed it pool
 * snapshots and act on its menu commands. Resolves when the service is stopped or
 * the user quits from the menu. Throws when the helper dies on its own, so the
 * service restarts it with backoff.
 */
export async function runMenuBar(bb: BbPluginApi, signal: AbortSignal): Promise<void> {
  if (process.platform !== "darwin") {
    bb.log.info("usage-bar: the menu bar item is macOS only; idling.");
    await untilAborted(signal);
    return;
  }

  // Dev bb instances auto-install workspace plugins and would each draw duplicate items.
  const defaultDataDir = join(homedir(), ".bb");
  if (
    resolve(bb.server.experimental_dataDir) !== defaultDataDir &&
    process.env.BB_USAGE_BAR_ANY_INSTANCE !== "1"
  ) {
    bb.log.info(`usage-bar: only the bb instance at ${defaultDataDir} draws the menu bar; idling.`);
    await untilAborted(signal);
    return;
  }

  const binary = await buildHelper(signal);
  const helperGone = new AbortController();
  const live = AbortSignal.any([signal, helperGone.signal]);
  const child = spawn(binary, [nativeDir()], { stdio: ["pipe", "pipe", "pipe"], signal });
  child.on("error", (error) => {
    if (!signal.aborted) bb.log.warn(`usage-bar: helper error: ${error.message}`);
  });
  createInterface({ input: child.stderr }).on("line", (line) => {
    bb.log.warn(`usage-bar helper: ${line}`);
  });
  // A write after the helper exits raises EPIPE here; the exit path handles it.
  child.stdin.on("error", () => {});
  // `close`, not `exit`: it waits for stdout to drain, so a final "quit" line is read first.
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      helperGone.abort();
      resolve(code);
    });
    child.once("error", () => {
      helperGone.abort();
      resolve(null);
    });
  });

  const send = (message: HelperInput) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  let lastSent = "";
  const render = () => {
    const last = state.snapshot();
    const body = JSON.stringify(last);
    if (body === lastSent) return;
    lastSent = body;
    send({ type: "snapshot", ...last });
  };
  const state = createMenuState(live, render);
  const readSource = createSourceReader(bb);

  const publish = (refresh = false) => state.publish(() => readSource(live, refresh), refresh);

  let refreshing = false;
  const refreshAll = async () => {
    if (refreshing) return;
    refreshing = true;
    send({ type: "refreshing", value: true });
    try {
      if (state.source?.kind === "pool") {
        await Promise.allSettled(
          state.source.providers.flatMap((provider) =>
            provider.accounts
              .filter((account) => account.status !== "disabled")
              .map((account) =>
                bb.sdk.plugins.callRpc({
                  pluginId: POOL_PLUGIN_ID,
                  method: "account.refreshUsage",
                  input: { accountId: account.id },
                  outputSchema: z.unknown(),
                  signal: live,
                }),
              ),
          ),
        );
      }
    } finally {
      try {
        await publish(true);
      } finally {
        refreshing = false;
        send({ type: "refreshing", value: false });
      }
    }
  };

  let quit = false;
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
        void publish();
        break;
      case "refresh":
        void refreshAll();
        break;
      case "openBb":
        spawn("open", ["-b", BB_BUNDLE_ID], { stdio: "ignore" }).on("error", () => {});
        break;
      case "quit":
        quit = true;
        child.kill();
        break;
    }
  });

  await Promise.race([publish(), exited]);
  const poll = (async () => {
    while (!live.aborted) {
      await sleep(POLL_MS, undefined, { signal: live }).catch(() => {});
      if (!live.aborted) await Promise.race([publish(), exited]);
    }
  })();

  const code = await Promise.race([exited, untilAborted(signal).then(() => null)]);
  helperGone.abort();
  child.kill();
  await poll;
  if (signal.aborted) return;
  // Quit from the menu hides the item until bb restarts or the plugin reloads.
  if (quit) return untilAborted(signal);
  throw new Error(`usage-bar: helper exited with code ${String(code)}`);
}
