import { expect, onTestFinished, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Effect } from "effect";
import { createPlacements } from "./placement.ts";
import { HOST_REMOVED, openStore } from "./store.ts";

/** A thread whose ready environment is on host_gone; bb answers for the machine as `machine` says. */
function world(machine: () => Promise<unknown>) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "source-control",
    sdk: {
      threads: {
        get: (async () => ({
          id: "thr_a",
          environment: { id: "env_a", hostId: "host_gone", path: "/repo", status: "ready" },
        })) as never,
      },
      hosts: { get: machine as never },
    },
  });
  // Disposing removes the fake host's storage dir.
  onTestFinished(() => harness.lifecycle.dispose());
  const store = openStore(bb);
  const placements = createPlacements({ bb, store, now: () => 1 });
  const settle = () => Effect.runPromise(placements.settle("thr_a")).then((each) => each.where);
  return { store, settle };
}

const notFound = () =>
  Promise.reject(
    Object.assign(new Error("Host not found"), { status: 404, code: "host_not_found" }),
  );

test("a thread on a machine bb removed is not placed back on it after the machine is forgotten", async () => {
  let removed = false;
  const { store, settle } = world(() =>
    removed ? notFound() : Promise.resolve({ id: "host_gone", name: "Grok box" }),
  );
  expect(await settle()).toMatchObject({ state: "checkout", placement: { hostName: "Grok box" } });
  removed = true;
  store.forgetHost("host_gone", 2);
  // A refresh while the thread's tab is open asks bb again: its environment still names the machine.
  expect(await settle()).toEqual({ state: "none", reason: HOST_REMOVED });
  expect(store.hostIds()).not.toContain("host_gone");
  expect(store.checkouts()).toEqual([]);
});

test("a machine bb did not answer for is still placed: only a 404 says it is gone", async () => {
  const { store, settle } = world(() => Promise.reject(new Error("bb is restarting")));
  expect(await settle()).toMatchObject({ state: "checkout", placement: { hostId: "host_gone" } });
  expect(store.hostIds()).toContain("host_gone");
});
