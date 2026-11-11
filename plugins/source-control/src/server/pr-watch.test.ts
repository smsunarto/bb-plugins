import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { WatchRead } from "../core/watch.ts";
import { createPrWatcher } from "./pr-watch.ts";
import { openStore } from "./store.ts";

const REF = { owner: "acme", repo: "api", number: 42 };
const READ: WatchRead = {
  url: "https://github.com/acme/api/pull/42",
  title: "Route gh",
  state: "open",
  baseRefName: "main",
  mergeState: "CLEAN",
  checks: { headRefOid: "c0ffee1", checks: [] },
  activity: [],
  pausedUntil: null,
};

test("each change to a thread's watches tells its banner, and Unwatch ends the watch", async () => {
  const { bb } = createFakePluginHost({ pluginId: "source-control" });
  const changed: string[] = [];
  const watcher = createPrWatcher({
    bb,
    store: openStore(bb),
    now: () => 2_000,
    standingDown: () => false,
    read: async () => ({ ok: true, login: "scott", value: READ }),
    changed: (threadId) => changed.push(threadId),
  });
  await watcher.watch("thr_a", REF);
  expect(changed).toEqual(["thr_a"]);
  expect(watcher.list("thr_a").map((record) => record.title)).toEqual(["Route gh"]);
  expect(await watcher.stop("thr_a", REF)).toBe(true);
  expect(changed).toEqual(["thr_a", "thr_a"]);
  expect(watcher.list("thr_a")).toEqual([]);
  expect(await watcher.stop("thr_a", REF)).toBe(false);
});
