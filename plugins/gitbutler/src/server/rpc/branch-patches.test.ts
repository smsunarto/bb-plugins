import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HostCall } from "../../../test/harness.ts";
import { branchPatches } from "./branch-patches.ts";

test("a branch's patches are a range diff on its own machine", async () => {
  const patches = { files: [], truncated: false };
  const calls: HostCall[] = [];
  const bb = {
    sdk: {
      hosts: {
        list: async () => [
          { id: "laptop", name: "Personal Mac", status: "connected" },
          { id: "server", name: "cardinal", status: "connected" },
        ],
      },
      projects: {
        list: async () => [{ sources: [{ hostId: "laptop", path: "/Users/me/app" }] }],
      },
      environments: { list: async () => [{ hostId: "server", path: "/work/env" }] },
    },
    hosts: {
      experimental_client: () => ({
        call: async (method: string, input: unknown, options: { hostId: string }) => {
          calls.push({ method, input, options });
          return patches;
        },
      }),
    },
  } as unknown as BbPluginApi;

  expect(
    await branchPatches.execute({ bb } as never, {
      hostId: "laptop",
      path: "/Users/me/app",
      base: "aaaaaaaa",
      head: "bbbbbbbb",
    }),
  ).toEqual(patches);
  expect(calls).toEqual([
    {
      method: "patches",
      input: {
        environmentPath: "/Users/me/app",
        source: { kind: "range", base: "aaaaaaaa", head: "bbbbbbbb", within: ["/Users/me/app"] },
      },
      options: { hostId: "laptop" },
    },
  ]);
});

test("a range is two commit ids, so neither can be read as a flag", async () => {
  await expect(
    callProcedure(branchPatches, { bb: {} } as never, {
      hostId: "laptop",
      path: "/Users/me/app",
      base: "--output=/tmp/x",
      head: "bbbbbbbb",
    }),
  ).rejects.toThrow("invalid input");
});

test("a machine where bb knows no checkout is not asked", async () => {
  const bb = {
    sdk: {
      hosts: { list: async () => [{ id: "laptop", name: "Personal Mac", status: "connected" }] },
      projects: { list: async () => [] },
      environments: { list: async () => [] },
    },
    hosts: {
      experimental_client: () => ({
        call: async () => {
          throw new Error("asked");
        },
      }),
    },
  } as unknown as BbPluginApi;

  await expect(
    branchPatches.execute({ bb } as never, {
      hostId: "laptop",
      path: "/Users/me/app",
      base: "aaaaaaaa",
      head: "bbbbbbbb",
    }),
  ).rejects.toThrow("bb knows no checkout on that machine, or it is offline.");
});
