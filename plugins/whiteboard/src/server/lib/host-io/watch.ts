import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FSWatcher, WatchListener } from "node:fs";
import { HOST_TIMEOUT_MS } from "../../../shared/contracts/host-contract.ts";
import { hostIo, onUninstall, onWorkerExit, onWorktreeChanged, routeHost } from "./client.ts";

/** How often armed watches are checked (`checkWatches`). */
export const WATCH_CHECK_MS = 10_000;

/** Watches a host has confirmed, by host: what `checkWatches` asks about. */
const armed = new Map<string, Set<HostWatcher>>();
/**
 * Runs `checkWatches` while any watch is armed, with or without a panel open:
 * an agent's reads trust the cached inspection as much as a panel's do.
 */
let supervisor: ReturnType<typeof setInterval> | undefined;

function track(hostId: string, watcher: HostWatcher) {
  let watchers = armed.get(hostId);
  if (!watchers) armed.set(hostId, (watchers = new Set()));
  watchers.add(watcher);
  supervisor ??= setInterval(() => void checkWatches().catch(() => {}), WATCH_CHECK_MS);
  supervisor.unref?.();
}

function untrack(hostId: string, watcher: HostWatcher) {
  const watchers = armed.get(hostId);
  if (!watchers?.delete(watcher) || watchers.size) return;
  armed.delete(hostId);
  if (armed.size) return;
  clearInterval(supervisor);
  supervisor = undefined;
}

/**
 * An `FSWatcher` over a host watch (design §1.3, §1.7). `listener` runs for
 * every coalesced change the host's native watcher reports, and once more
 * after a host worker restart, because changes made while no worker watched
 * are unknown. A worker exit re-arms the watch, and so does `checkWatches`
 * when the host no longer holds it. A host `watch-error`, or a failure to
 * start, emits `error` (upstream then stops trusting its cache).
 */
class HostWatcher extends EventEmitter {
  readonly watchId = randomUUID();
  private hostId: string | undefined;
  private client: ReturnType<typeof hostIo>["client"] | undefined;
  private closed = false;
  private readonly offs: Array<() => void> = [];

  constructor(
    private readonly rootPath: string,
    private readonly gitCommonDir: string | undefined,
    private readonly listener: WatchListener<string>,
  ) {
    super();
    void this.start();
  }

  private fail(error: unknown) {
    if (this.closed || this.listenerCount("error") === 0) return;
    this.emit("error", error instanceof Error ? error : new Error(String(error)));
  }

  private async start() {
    try {
      this.client = hostIo().client;
      const hostId = await routeHost({ rootPath: this.rootPath });
      if (this.closed) return;
      this.hostId = hostId;
      this.offs.push(
        onWorktreeChanged(this.watchId, hostId, (payload) => {
          if (this.closed) return;
          if (payload.kind === "watch-error")
            this.fail(new Error(`whiteboard: the host stopped watching ${this.rootPath}.`));
          else this.listener("change", null);
        }),
        onWorkerExit((exited) => {
          if (exited === hostId) this.rearm();
        }),
        onUninstall(() => this.close()),
      );
      await this.arm();
      // The first inspection may finish before this asynchronous watch starts.
      // Invalidate once after arming so changes in that gap cannot stay cached.
      if (!this.closed) this.listener("rename", null);
    } catch (error) {
      this.fail(error);
    }
  }

  private async arm() {
    try {
      await this.client!.call(
        "watchWorktree",
        {
          watchId: this.watchId,
          rootPath: this.rootPath,
          ...(this.gitCommonDir && { gitCommonDir: this.gitCommonDir }),
        },
        { hostId: this.hostId! },
      );
      // Closed while the arm was in flight: close()'s unwatch may have landed first.
      if (this.closed) this.unwatch();
      else track(this.hostId!, this);
    } catch (error) {
      this.fail(error);
    }
  }

  /** The host lost the watch: changes since are unknown, so invalidate, then watch again. */
  rearm() {
    if (this.closed) return;
    // Not checked again until the host confirms the new watch.
    untrack(this.hostId!, this);
    this.listener("rename", null);
    void this.arm();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.hostId) untrack(this.hostId, this);
    for (const off of this.offs.splice(0)) off();
    this.unwatch();
    this.emit("close");
  }

  private unwatch() {
    if (this.hostId && this.client)
      void this.client
        .call("unwatchWorktree", { watchId: this.watchId }, { hostId: this.hostId })
        .catch(() => {});
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }
}

/**
 * `fs.watch(root, { recursive: true }, listener)` on the host that owns `root`.
 * `gitCommonDir` names the repository's Git common directory, which the
 * caller watches as a root of its own: the host skips Git bookkeeping by it.
 */
export function watch(
  rootPath: string,
  options: { recursive?: boolean; gitCommonDir?: string | null } | undefined,
  listener: WatchListener<string>,
): FSWatcher {
  return new HostWatcher(
    rootPath,
    options?.gitCommonDir ?? undefined,
    listener,
  ) as unknown as FSWatcher;
}

/**
 * Re-arm every watch its host no longer holds. A host daemon restart, or a
 * graceful worker stop, drops the host's watches without the worker exit
 * that re-arms them, and the cached inspection would never change again.
 * One `watchAlive` call per host. A host that cannot answer keeps its
 * watches until a later check reaches it.
 */
export async function checkWatches(): Promise<void> {
  await Promise.all(
    [...armed].map(async ([hostId, watchers]) => {
      const asked = [...watchers];
      const answer = await hostIo()
        .client.call(
          "watchAlive",
          { watchIds: asked.map((watcher) => watcher.watchId) },
          { hostId, timeoutMs: HOST_TIMEOUT_MS.probe },
        )
        .catch(() => undefined);
      if (!answer) return;
      const live = new Set(answer.live);
      for (const watcher of asked) if (!live.has(watcher.watchId)) watcher.rearm();
    }),
  );
}
