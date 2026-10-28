import { expect, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HostCall } from "../../../test/harness.ts";
import type { UnpublishedBranch } from "../../shared/schema.ts";
import { unpublishedBranchesAt } from "./unpublished-branches-at.ts";
import { unpublishedBranches } from "./unpublished-branches.ts";

const branch = (name: string): UnpublishedBranch => ({
  path: "/work/app",
  repoName: "app",
  origin: "github.com/o/app",
  branch: name,
  status: "unpushed",
  head: "bbbbbbbb",
  base: "aaaaaaaa",
  parent: null,
  commits: [],
});

/**
 * A bb with a connected server, a connected laptop that fails to answer,
 * and a machine that is asleep. `answers` is each host's reply by host id.
 */
function machines(answers: Record<string, unknown>) {
  const calls: HostCall[] = [];
  const bb = {
    sdk: {
      hosts: {
        list: async () => [
          { id: "cardinal", name: "linux-builder", status: "connected" },
          { id: "laptop", name: "Local Mac", status: "connected" },
          { id: "asleep", name: "Build Mac", status: "disconnected" },
        ],
        get: async () => ({ status: "connected" }),
      },
      projects: {
        list: async () => [
          {
            sources: [
              { hostId: "cardinal", path: "/work/app" },
              { hostId: "laptop", path: "/Users/me/app" },
              { hostId: "asleep", path: "/Users/me/app" },
            ],
          },
        ],
      },
      environments: { list: async () => [{ hostId: "cardinal", path: "/work/env-1" }] },
    },
    hosts: {
      experimental_client: () => ({
        call: async (method: string, input: unknown, options: { hostId: string }) => {
          calls.push({ method, input, options });
          const answer = answers[options.hostId];
          if (!answer) throw new Error("not answering");
          return answer;
        },
      }),
    },
    log: { warn: () => {} },
  } as unknown as BbPluginApi;
  return { ctx: { bb }, calls };
}

test("asks every connected machine for its unpublished branches and names the machine", async () => {
  const { ctx, calls } = machines({ cardinal: { branches: [branch("scott/feature")] } });

  expect(await unpublishedBranches(ctx as never)).toEqual({
    branches: [{ ...branch("scott/feature"), hostId: "cardinal", machine: "linux-builder" }],
  });
  // The laptop failed and is left out; the sleeping machine is never asked.
  expect(calls).toEqual([
    {
      method: "unpublishedBranches",
      input: { paths: ["/work/app", "/work/env-1"] },
      options: { hostId: "cardinal", timeoutMs: 30_000 },
    },
    {
      method: "unpublishedBranches",
      input: { paths: ["/Users/me/app"] },
      options: { hostId: "laptop", timeoutMs: 30_000 },
    },
  ]);
});

test("a scoped lookup contacts only the named host and preserves the checkout boundary", async () => {
  const { ctx, calls } = machines({ cardinal: { branches: [branch("scott/feature")] } });
  await unpublishedBranchesAt(ctx as never, { hostId: "cardinal", path: "/work/app" });
  expect(calls).toEqual([
    {
      method: "unpublishedBranches",
      input: { paths: ["/work/app", "/work/env-1"], path: "/work/app" },
      options: { hostId: "cardinal", timeoutMs: 30_000 },
    },
  ]);
  await expect(unpublishedBranchesAt(ctx as never, { hostId: "laptop" })).rejects.toThrow(
    "not answering",
  );
  await expect(unpublishedBranchesAt(ctx as never, { hostId: "asleep" })).rejects.toThrow(
    "offline",
  );
});
