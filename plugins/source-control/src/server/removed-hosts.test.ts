import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Effect } from "effect";
import { hostTag, PAGE_SOURCES_TAG, threadTag } from "../core/ids.ts";
import type { ForgeSites } from "./forge-sites.ts";
import type { LocalReads } from "./local-read.ts";
import { createReviewSources } from "./review-sources.ts";
import { HOST_REMOVED, openStore } from "./store.ts";

const placement = (hostId: string, path: string) => ({
  state: "checkout" as const,
  placement: { hostId, hostName: hostId, path, environmentId: `env-${hostId}` },
});

/** Two machines with a checkout, a read and a setting each; bb answers `known`. */
function world(known: () => Promise<string[]>) {
  const { bb } = createFakePluginHost({ pluginId: "source-control" });
  const store = openStore(bb);
  const db = bb.storage.database();
  for (const [threadId, hostId] of [
    ["thr_gone", "host_gone"],
    ["thr_away", "host_away"],
  ] as const) {
    store.setPlacement(threadId, placement(hostId, "/repo"), 1);
    db.prepare(`INSERT INTO local_facet (host_id, path, json) VALUES (?, ?, ?)`).run(
      hostId,
      "/repo",
      JSON.stringify({ read: null, problem: null }),
    );
    store.setReadAs(hostId, "/repo", "git");
  }
  const invalidated: string[] = [];
  const sources = createReviewSources({
    store,
    sites: {} as ForgeSites,
    local: {} as LocalReads,
    share: (_key, work) => work,
    invalidate: (tags) => invalidated.push(...tags),
    now: () => 10,
    knownHosts: Effect.tryPromise(known),
  });
  const rowsOn = (hostId: string) =>
    (
      db
        .prepare(
          `SELECT (SELECT count(*) FROM thread_checkout WHERE host_id = ?)
                + (SELECT count(*) FROM local_facet WHERE host_id = ?)
                + (SELECT count(*) FROM checkout_read_as WHERE host_id = ?) AS n`,
        )
        .get(hostId, hostId, hostId) as { n: number }
    ).n;
  return { store, sources, invalidated, rowsOn };
}

test("a machine bb removed is forgotten; an offline one bb still lists is kept", async () => {
  // host_away is disconnected, but bb still lists it.
  const { store, sources, invalidated, rowsOn } = world(async () => ["host_away", "host_dev"]);
  expect(await Effect.runPromise(sources.pruneRemovedHosts)).toBe(4);
  expect(rowsOn("host_gone")).toBe(0);
  expect(store.placement("thr_gone")).toEqual({ state: "none", reason: HOST_REMOVED });
  expect(store.checkouts().map((each) => each.hostId)).toEqual(["host_away"]);
  expect(rowsOn("host_away")).toBe(3);
  expect(invalidated).toEqual([PAGE_SOURCES_TAG, hostTag("host_gone"), threadTag("thr_gone")]);
  // Idempotent: nothing is left to forget.
  expect(await Effect.runPromise(sources.pruneRemovedHosts)).toBe(0);
});

test.each([
  ["fails", () => Promise.reject(new Error("bb is restarting"))],
  ["lists no machine", () => Promise.resolve([])],
])("when bb's machine list %s, every host is kept", async (_, known) => {
  const { store, sources, rowsOn } = world(known);
  expect(await Effect.runPromise(sources.pruneRemovedHosts)).toBe(0);
  expect(store.hostIds().toSorted()).toEqual(["host_away", "host_gone"]);
  expect(rowsOn("host_gone")).toBe(3);
});

test("a machine enrolled again under the same id is listed again once a thread is placed on it", async () => {
  let known = ["host_away"];
  const { store, sources } = world(async () => known);
  await Effect.runPromise(sources.pruneRemovedHosts);
  expect(store.hostIds()).not.toContain("host_gone");
  known = ["host_away", "host_gone"];
  store.setPlacement("thr_gone", placement("host_gone", "/repo"), 20);
  expect(await Effect.runPromise(sources.pruneRemovedHosts)).toBe(0);
  expect(store.checkouts().map((each) => each.hostId)).toEqual(["host_away", "host_gone"]);
  expect(sources.checkoutHosts().hosts.map((host) => host.hostId)).toEqual([
    "host_away",
    "host_gone",
  ]);
});
