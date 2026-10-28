import { expect, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HostCall } from "../../../test/harness.ts";
import { branchBlobs, branchBlobsContract } from "./branch-blobs.ts";

function machine(calls: HostCall[], answer: unknown) {
  return {
    sdk: {
      hosts: { list: async () => [{ id: "laptop", name: "Local Mac", status: "connected" }] },
      projects: {
        list: async () => [{ sources: [{ hostId: "laptop", path: "/Users/me/app" }] }],
      },
      environments: { list: async () => [] },
    },
    hosts: {
      experimental_client: () => ({
        call: async (method: string, input: unknown, options: { hostId: string }) => {
          calls.push({ method, input, options });
          return answer;
        },
      }),
    },
  } as unknown as BbPluginApi;
}

test("descriptors are read on the branch's own machine, within the checkouts bb knows", async () => {
  const calls: HostCall[] = [];
  const answer = { items: [{ kind: "missing" as const }] };
  expect(
    await branchBlobs({ bb: machine(calls, answer) } as never, {
      hostId: "laptop",
      path: "/Users/me/app",
      items: [{ rev: "aaaaaaaa", path: "Assets/hero.png" }],
    }),
  ).toEqual(answer);
  expect(calls).toEqual([
    {
      method: "blobs",
      input: {
        environmentPath: "/Users/me/app",
        within: ["/Users/me/app"],
        items: [{ rev: "aaaaaaaa", path: "Assets/hero.png" }],
      },
      options: { hostId: "laptop" },
    },
  ]);
});

test("a revision is a commit id, so it can never be read as a flag", async () => {
  // The host validates every call before it runs, so the handler never sees this.
  expect(
    branchBlobsContract.input.safeParse({
      hostId: "laptop",
      path: "/Users/me/app",
      items: [{ rev: "--output=/tmp/x", path: "a.png" }],
    }).success,
  ).toBe(false);
});
