import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Context } from "@bb-kit/core/plugin";
import { imageTooLargeError } from "./prepare.ts";
import type { ReadLocalFile } from "./prepare.ts";
import { createPageStore } from "./store.ts";
import type { PageStore } from "./store.ts";

const MAX_CONCURRENT_BROWSERS = 2;

export interface HtmlServices {
  store: PageStore;
  settings: { get(): Promise<{ chromePath: string; chromeNoSandbox: boolean }> };
  /** Runs `task` once one of the bounded browser slots is free, unless `signal` aborts first. */
  withBrowser<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Reads files from the machine the thread's agent runs on. */
  threadFiles(threadId: string, signal: AbortSignal): ReadLocalFile;
}

export type HtmlContext = Context<HtmlServices>;

export function createServices(bb: BbPluginApi): HtmlServices {
  const settings = bb.settings.define({
    chromePath: {
      type: "string",
      label: "Chrome path",
      description:
        "Chrome or Chromium on the bb server that html_preview runs headless. Leave empty to search the usual install locations.",
      default: "",
    },
    chromeNoSandbox: {
      type: "boolean",
      label: "Run Chrome without its sandbox",
      description:
        "Needed only where Chrome's sandbox cannot start, such as a root account or AppArmor-restricted Ubuntu. Previews then run with less isolation.",
      default: false,
    },
  });

  let active = 0;
  const waiting: Array<() => void> = [];
  async function withBrowser<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (active < MAX_CONCURRENT_BROWSERS) active += 1;
    else {
      await new Promise<void>((resolve, reject) => {
        const admit = () => {
          signal?.removeEventListener("abort", cancel);
          resolve();
        };
        // A cancelled preview leaves the queue instead of taking a slot later.
        const cancel = () => {
          waiting.splice(waiting.indexOf(admit), 1);
          reject(signal?.reason);
        };
        waiting.push(admit);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    }
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      // Hand the slot straight to the next waiter so a newcomer cannot take it first.
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  }

  // The thread's environment names the machine whose absolute paths the agent wrote.
  async function threadHost(threadId: string, signal: AbortSignal) {
    const thread = await bb.sdk.threads.get({ threadId, signal });
    if (!thread.environmentId) return undefined;
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
      signal,
    });
    return environment.hostId || undefined;
  }

  function threadFiles(threadId: string, signal: AbortSignal): ReadLocalFile {
    let host: Promise<string | undefined> | undefined;
    return async (path) => {
      host ??= threadHost(threadId, signal);
      const hostId = await host;
      try {
        const file = await bb.sdk.files.read({ path, signal, ...(hostId ? { hostId } : {}) });
        return Buffer.from(file.content, file.contentEncoding === "base64" ? "base64" : "utf8");
      } catch (error) {
        // The host refuses oversize files before reading them; say so instead of "missing".
        const size = /File size (\d+) bytes exceeds/.exec(String((error as Error)?.message))?.[1];
        if (size !== undefined) throw imageTooLargeError(path, Number(size));
        throw error;
      }
    };
  }

  return {
    store: createPageStore(bb),
    settings: {
      async get() {
        const values = await settings.get();
        return { chromePath: values.chromePath.trim(), chromeNoSandbox: values.chromeNoSandbox };
      },
    },
    withBrowser,
    threadFiles,
  };
}
