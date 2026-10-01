import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FSWatcher, WatchListener } from "node:fs";
import { hostIo, onUninstall, onWorkerExit, onWorktreeChanged, routeHost } from "./client.ts";

/**
 * An `FSWatcher` over a host watch (design §1.3, §1.7). `listener` runs for
 * every coalesced change the host's native watcher reports, and once more
 * after a host worker restart, because changes made while no worker watched
 * are unknown. A worker exit re-arms the watch. A host `watch-error`, or a
 * failure to start, emits `error` (upstream then stops trusting its cache).
 */
class HostWatcher extends EventEmitter {
  private readonly watchId = randomUUID();
  private hostId: string | undefined;
  private client: ReturnType<typeof hostIo>["client"] | undefined;
  private closed = false;
  private readonly offs: Array<() => void> = [];

  constructor(
    private readonly rootPath: string,
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
          if (exited !== hostId || this.closed) return;
          this.listener("rename", null);
          void this.arm();
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
        { watchId: this.watchId, rootPath: this.rootPath },
        { hostId: this.hostId! },
      );
      // Closed while the arm was in flight: close()'s unwatch may have landed first.
      if (this.closed) this.unwatch();
    } catch (error) {
      this.fail(error);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
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

/** `fs.watch(root, { recursive: true }, listener)` on the host that owns `root`. */
export function watch(
  rootPath: string,
  _options: { recursive?: boolean } | undefined,
  listener: WatchListener<string>,
): FSWatcher {
  return new HostWatcher(rootPath, listener) as unknown as FSWatcher;
}
