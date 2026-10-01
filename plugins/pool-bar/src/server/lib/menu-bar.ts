import { spawn } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { AccountExtras } from "./extras.ts";
import { buildHelper, nativeDir } from "./helper.ts";
import type { MenuSnapshot } from "./pool.ts";
import { POOL_PLUGIN_ID, createSourceReader, type Source } from "./sources.ts";

/** Reading the pool is a local store read; quota itself moves on proxied traffic. */
const POLL_MS = 15_000;
/** Extras hit provider endpoints (Claude's usage endpoint rate-limits), so poll them slowly. */
const EXTRAS_MS = 5 * 60_000;
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
    bb.log.info("pool-bar: the menu bar item is macOS only; idling.");
    await untilAborted(signal);
    return;
  }

  // Dev bb instances auto-install workspace plugins and would each draw duplicate items.
  const defaultDataDir = join(homedir(), ".bb");
  if (
    resolve(bb.server.experimental_dataDir) !== defaultDataDir &&
    process.env.BB_POOL_BAR_ANY_INSTANCE !== "1"
  ) {
    bb.log.info(`pool-bar: only the bb instance at ${defaultDataDir} draws the menu bar; idling.`);
    await untilAborted(signal);
    return;
  }

  const binary = await buildHelper(signal);
  const child = spawn(binary, [nativeDir()], { stdio: ["pipe", "pipe", "pipe"], signal });
  child.on("error", (error) => {
    if (!signal.aborted) bb.log.warn(`pool-bar: helper error: ${error.message}`);
  });
  createInterface({ input: child.stderr }).on("line", (line) => {
    bb.log.warn(`pool-bar helper: ${line}`);
  });
  // A write after the helper exits raises EPIPE here; the exit path handles it.
  child.stdin.on("error", () => {});
  // `close`, not `exit`: it waits for stdout to drain, so a final "quit" line is read first.
  const exited = once(child, "close");

  const send = (message: HelperInput) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  let last: MenuSnapshot = { providers: [], error: null };
  let lastSent = "";
  const extras = new Map<string, AccountExtras>();
  const render = () => {
    const body = JSON.stringify(last);
    if (body === lastSent) return;
    lastSent = body;
    send({ type: "snapshot", ...last });
  };

  const readSource = createSourceReader(bb);
  let source: Source | null = null;
  let extrasAt = 0;
  let extrasRunning = false;
  const attachExtras = () => {
    last = {
      ...last,
      providers: last.providers.map((provider) => ({
        ...provider,
        accounts: provider.accounts.map((account) => ({ ...account, ...extras.get(account.id) })),
      })),
    };
  };
  const refreshExtras = async (force: boolean) => {
    if (source === null || extrasRunning || (!force && Date.now() - extrasAt < EXTRAS_MS)) return;
    extrasRunning = true;
    extrasAt = Date.now();
    const current = source;
    try {
      // allSettled: a rejection here would escape the detached call and crash the service.
      await Promise.allSettled(
        current.providers.flatMap((provider) =>
          provider.accounts
            .filter((account) => account.status !== "disabled")
            .map(async (account) => {
              extras.set(account.id, await current.extras(provider.id, account.id));
            }),
        ),
      );
    } finally {
      extrasRunning = false;
    }
    if (signal.aborted) return;
    attachExtras();
    render();
  };

  let publication = 0;
  const publish = async (refresh = false) => {
    const version = ++publication;
    try {
      const next = await readSource(signal, refresh);
      if (signal.aborted || version !== publication) return;
      const ids = next.providers.flatMap((provider) =>
        provider.accounts.map((account) => account.id),
      );
      if (
        JSON.stringify(ids) !==
        JSON.stringify(
          source?.providers.flatMap((provider) => provider.accounts.map((account) => account.id)),
        )
      )
        extrasAt = 0;
      for (const key of extras.keys()) if (!ids.includes(key)) extras.delete(key);
      source = next;
      last = { providers: source.providers, error: null };
      attachExtras();
    } catch {
      if (signal.aborted || version !== publication) return;
      // Keep the last good accounts on screen, dimmed, rather than blanking the menu.
      last = { ...last, error: "Usage unavailable. Check the provider in bb." };
    }
    render();
    void refreshExtras(refresh);
  };

  let refreshing = false;
  const refreshAll = async () => {
    if (refreshing) return;
    refreshing = true;
    send({ type: "refreshing", value: true });
    try {
      if (source?.kind === "pool") {
        await Promise.allSettled(
          source.providers.flatMap((provider) =>
            provider.accounts
              .filter((account) => account.status !== "disabled")
              .map((account) =>
                bb.sdk.plugins.callRpc({
                  pluginId: POOL_PLUGIN_ID,
                  method: "account.refreshUsage",
                  input: { accountId: account.id },
                  outputSchema: z.unknown(),
                  signal,
                }),
              ),
          ),
        );
      }
    } finally {
      refreshing = false;
      await publish(true);
      send({ type: "refreshing", value: false });
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

  await publish();
  const helperGone = new AbortController();
  const live = AbortSignal.any([signal, helperGone.signal]);
  const poll = (async () => {
    while (!live.aborted) {
      await sleep(POLL_MS, undefined, { signal: live }).catch(() => {});
      if (!live.aborted) await publish();
    }
  })();

  const [code] = await Promise.race([exited, untilAborted(signal).then(() => [null])]);
  helperGone.abort();
  child.kill();
  await poll;
  if (signal.aborted) return;
  // Quit from the menu hides the item until bb restarts or the plugin reloads.
  if (quit) return untilAborted(signal);
  throw new Error(`pool-bar: helper exited with code ${String(code)}`);
}
