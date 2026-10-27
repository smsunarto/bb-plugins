import { BLOB_CHUNK_TIMEOUT_MS } from "../../shared/host-contract.ts";
import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HostCall } from "../../../test/harness.ts";
import { branchBlobChunk } from "./branch-blob-chunk.ts";

test("a chunk is read on the branch's own machine", async () => {
  const calls: HostCall[] = [];
  const bb = {
    sdk: {
      hosts: { list: async () => [{ id: "laptop", name: "Local Mac", status: "connected" }] },
      projects: { list: async () => [] },
      environments: { list: async () => [{ hostId: "laptop", path: "/work/env" }] },
    },
    hosts: {
      experimental_client: () => ({
        call: async (method: string, input: unknown, options: { hostId: string }) => {
          calls.push({ method, input, options });
          return { size: 3, content: "YWJj" };
        },
      }),
    },
  } as unknown as BbPluginApi;
  const object = { kind: "git" as const, oid: "a".repeat(40) };
  expect(
    await branchBlobChunk.execute({ bb } as never, {
      hostId: "laptop",
      path: "/work/env",
      object,
      offset: 0,
      length: 1024,
    }),
  ).toEqual({ size: 3, content: "YWJj" });
  expect(calls[0]).toEqual({
    method: "blobChunk",
    input: { environmentPath: "/work/env", within: ["/work/env"], object, offset: 0, length: 1024 },
    // A first chunk may download its LFS object, so the call outlasts bb's 30-second default.
    options: { hostId: "laptop", timeoutMs: BLOB_CHUNK_TIMEOUT_MS },
  });
});

test("an LFS oid must be sha256 hex, since the host turns it into a store path", async () => {
  await expect(
    callProcedure(branchBlobChunk, { bb: {} } as never, {
      hostId: "laptop",
      path: "/work/env",
      object: { kind: "lfs", oid: "../../etc/passwd", size: 3 },
      offset: 0,
      length: 1024,
    }),
  ).rejects.toThrow("invalid input");
});
