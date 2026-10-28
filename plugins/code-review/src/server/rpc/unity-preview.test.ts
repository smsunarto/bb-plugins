import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { unityPreview, unityPreviewContract } from "./unity-preview.ts";

const comparison = {
  kind: "local" as const,
  hostId: "laptop",
  path: "/Users/me/game",
  base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  head: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
};

test("answers a Unity asset's change in the shared schema", async () => {
  const { ctx } = fakeContext();
  ctx.unity.read = async () => ({ state: "unavailable", reason: "binary" });
  expect(
    unityPreviewContract.output.parse(
      await unityPreview(ctx, { comparison, path: "Main.unity", previousPath: null }),
    ),
  ).toEqual({ state: "unavailable", reason: "binary" });
});
