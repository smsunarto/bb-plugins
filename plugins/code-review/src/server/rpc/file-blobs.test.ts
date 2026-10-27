import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext } from "../../../test/fake-gh.ts";
import { fileBlobs } from "./file-blobs.ts";

const comparison = {
  kind: "local" as const,
  hostId: "laptop",
  path: "/Users/me/game",
  base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  head: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
};

test("each side's descriptor comes from the branch's machine", async () => {
  const { ctx } = fakeContext();
  ctx.blobs.describe = async (_comparison, path, previousPath) => {
    expect([path, previousPath]).toEqual(["New.png", "Old.png"]);
    return { base: { kind: "blob", size: 10, lfs: null }, head: { kind: "missing" } };
  };
  expect(
    await callProcedure(fileBlobs, ctx, { comparison, path: "New.png", previousPath: "Old.png" }),
  ).toEqual({ base: { kind: "blob", size: 10, lfs: null }, head: { kind: "missing" } });
});

test("a comparison names full commit ids, never refs", async () => {
  const { ctx } = fakeContext();
  await expect(
    callProcedure(fileBlobs, ctx, {
      comparison: { ...comparison, head: "main" },
      path: "a.png",
      previousPath: null,
    }),
  ).rejects.toThrow("invalid input");
});
