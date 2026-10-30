import { expect, test } from "bun:test";
import type { BlobRequest } from "../../shared/blob-url.ts";
import type { Comparison } from "../../shared/schema.ts";
import { BlobError, type BlobReader } from "./blobs.ts";
import { createUnityPreviews } from "./unity-preview.ts";

const comparison: Comparison = {
  kind: "local",
  hostId: "laptop",
  path: "/Users/me/game",
  base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  head: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
};

const prefab = (speed: number) => `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &1
GameObject:
  m_Name: Player
--- !u!114 &2
MonoBehaviour:
  m_GameObject: {fileID: 1}
  m_EditorClassIdentifier: Assembly-CSharp::Mover
  speed: ${speed}
`;

function files(sides: Record<string, string | null | Error>) {
  const reads: BlobRequest[] = [];
  const reader: BlobReader = {
    describe: async () => ({}) as never,
    open: async () => ({}) as never,
    async text(request) {
      reads.push(request);
      const found = sides[`${request.side}:${request.path}`];
      if (found instanceof Error) throw found;
      return found ?? null;
    },
  };
  return { reader, reads };
}

test("a prefab compares as objects, the old path on the base side of a rename", async () => {
  const { reader, reads } = files({ "base:Old.prefab": prefab(5), "head:New.prefab": prefab(8) });
  const preview = await createUnityPreviews(reader).read(comparison, "New.prefab", "Old.prefab");
  expect(preview).toMatchObject({ state: "objects", diff: { propertyCount: 1 } });
  expect(reads.map((read) => `${read.side}:${read.path}`).toSorted()).toEqual([
    "base:Old.prefab",
    "head:New.prefab",
  ]);
});

test("a .meta file compares its GUID and import settings", async () => {
  const meta = (guid: string) =>
    `fileFormatVersion: 2\nguid: ${guid}\nDefaultImporter:\n  userData:\n`;
  const { reader } = files({
    "base:a.png.meta": meta("0".repeat(32)),
    "head:a.png.meta": meta("1".repeat(32)),
  });
  const preview = await createUnityPreviews(reader).read(comparison, "a.png.meta", null);
  expect(preview).toMatchObject({
    state: "meta",
    diff: { guid: { before: "0".repeat(32), after: "1".repeat(32) } },
  });
});

test("a binary-serialized asset or an oversized one shows its text diff with a reason", async () => {
  const binary = files({
    "base:Light.asset": "\u0000\u0001binary",
    "head:Light.asset": "\u0000\u0002binary",
  });
  expect(
    await createUnityPreviews(binary.reader).read(comparison, "Light.asset", null),
  ).toMatchObject({
    state: "unavailable",
  });
  const huge = files({
    "head:Huge.unity": new BlobError(413, "That file is too large to compare as objects."),
  });
  expect(await createUnityPreviews(huge.reader).read(comparison, "Huge.unity", null)).toEqual({
    state: "unavailable",
    reason: "That file is too large to compare as objects.",
  });
});

test("a read that fails is not remembered, so asking again retries", async () => {
  let fail = true;
  const reader: BlobReader = {
    describe: async () => ({}) as never,
    open: async () => ({}) as never,
    async text(request) {
      if (fail) throw new BlobError(503, "Local Mac is not connected.");
      return request.side === "head" ? prefab(8) : prefab(5);
    },
  };
  const previews = createUnityPreviews(reader);
  await expect(previews.read(comparison, "P.prefab", null)).rejects.toThrow("not connected");
  fail = false;
  expect(await previews.read(comparison, "P.prefab", null)).toMatchObject({ state: "objects" });
});

test("both sides that never finish reading fail at the read's deadline, as a 504", async () => {
  const reader: BlobReader = {
    describe: async () => ({}) as never,
    open: async () => ({}) as never,
    text: (_request, _maxBytes, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  };
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, ms?: number) =>
    real(handler, (ms ?? 0) >= 1000 ? 0 : ms)) as typeof setTimeout;
  try {
    await expect(
      createUnityPreviews(reader).read(comparison, "P.prefab", null),
    ).rejects.toMatchObject({ status: 504, message: "Reading the asset took too long." });
  } finally {
    globalThis.setTimeout = real;
  }
});

test("an asset asked for twice at once is read once", async () => {
  const { reader, reads } = files({ "base:P.prefab": prefab(5), "head:P.prefab": prefab(8) });
  const previews = createUnityPreviews(reader);
  const [a, b] = await Promise.all([
    previews.read(comparison, "P.prefab", null),
    previews.read(comparison, "P.prefab", null),
  ]);
  expect(a).toEqual(b);
  expect(reads).toHaveLength(2);
});
