// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useLayoutEffect } from "react";
import { afterEach, expect, test } from "vitest";
import { vcsActionSchema, type VcsAction } from "../core/change.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { useVcsActions } from "./branch-actions.tsx";
import { HOST_BOUND, offlineReason } from "./host-gate.ts";

afterEach(cleanup);

/** One of each write. A new action kind does not compile until it has one here. */
const SAMPLES: { [K in VcsAction["kind"]]: Extract<VcsAction, { kind: K }> } = {
  push: { kind: "push", branch: "scott/a", force: false, acceptedLoss: [] },
  pull: { kind: "pull", accepted: null },
  land: { kind: "land", branch: "scott/a", message: null, accepted: null },
  rename: { kind: "rename", branch: "scott/a", name: "scott/b" },
  delete: { kind: "delete", branch: "scott/a", accepted: null },
  commit: { kind: "commit", branch: "scott/a", message: "m", paths: ["a.ts"] },
};

test("every write the host runs is behind the gate", () => {
  const kinds = vcsActionSchema.options.map((option) => option.shape.kind.value);
  expect(kinds.toSorted()).toEqual(Object.keys(SAMPLES).toSorted());
  for (const kind of kinds) expect(HOST_BOUND).toHaveProperty(kind);
  expect(HOST_BOUND).toHaveProperty("createPullRequest");
  expect(offlineReason("studio-mac")).toBe(
    "studio-mac is offline. Pull, commit, push, land, rename, delete and Create PR need it.",
  );
});

test("with the gate closed, no write of any kind is sent, and each says why", async () => {
  const sent: unknown[] = [];
  const seen: { current: ReturnType<typeof useVcsActions> | null } = { current: null };
  const reason = offlineReason("studio-mac");
  function Probe() {
    const actions = useVcsActions("thread-a", reason);
    useLayoutEffect(() => {
      seen.current = actions;
    });
    return null;
  }
  renderSlot(
    { component: Probe },
    {},
    {
      experimental_rpcContract: sourceControlContract,
      rpc: {
        vcsAction: (input: unknown) => {
          sent.push(input);
          return { status: "done" as const };
        },
      } as never,
    },
  );
  for (const action of Object.values(SAMPLES))
    await act(async () => seen.current!.dispatch.send(action, { head: "h", target: "t" }));
  expect(sent).toEqual([]);
  const outcomes = [...seen.current!.outcomes.values()];
  expect(outcomes.length).toBeGreaterThan(0);
  for (const outcome of outcomes) expect(outcome).toEqual({ kind: "failed", text: reason });
});
