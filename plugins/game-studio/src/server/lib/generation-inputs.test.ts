import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { mediaRequest, generationImagePaths } from "../../shared/generation.ts";
import { gameSchema } from "../../shared/schema.ts";
import { captureCanvasInputs } from "./generation-inputs.ts";

const shaA = "559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd";
const shaB = "df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c";
const snapshotA = `canvas/inputs/${shaA}.png`;
const snapshotB = `canvas/inputs/${shaB}.png`;
const game = gameSchema.parse({
  id: "orbit",
  name: "Orbit",
  hostId: "remote-host",
  projectId: "project",
  rootPath: "/games/orbit",
  kind: "unity",
  createdAt: 0,
  threadId: null,
});
type File = {
  content: string;
  contentEncoding: "utf8" | "base64";
  sha256: string;
  sizeBytes: number;
};
type Location = { hostId?: string; rootPath?: string; path: string };
type Write = Location & {
  content: string;
  contentEncoding?: "utf8" | "base64";
  expectedSha256?: string | null;
  createParents?: boolean;
};
function fake() {
  const files = new Map<string, File>();
  const reads: Location[] = [];
  const writes: Write[] = [];
  const successfulWrites: string[] = [];
  const seed = (path: string, bytes: string, overrides: Partial<File> = {}) => {
    files.set(`/games/orbit/${path}`, {
      content: Buffer.from(bytes).toString("base64"),
      contentEncoding: "base64",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: Buffer.byteLength(bytes),
      ...overrides,
    });
  };
  const bb = {
    sdk: {
      files: {
        read: async (input: Location) => {
          reads.push(input);
          const file = files.get(input.path);
          if (!file) throw new Error(`ENOENT: ${input.path}`);
          return { path: input.path, ...file };
        },
        write: async (input: Write) => {
          writes.push(input);
          const previous = files.get(input.path);
          if (input.expectedSha256 !== (previous?.sha256 ?? null))
            return { outcome: "conflict", currentSha256: previous?.sha256 ?? null };
          const bytes = Buffer.from(
            input.content,
            input.contentEncoding === "base64" ? "base64" : "utf8",
          );
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          files.set(input.path, {
            content: input.content,
            contentEncoding: input.contentEncoding ?? "utf8",
            sha256,
            sizeBytes: bytes.length,
          });
          successfulWrites.push(input.path);
          return { outcome: "written", sha256, sizeBytes: bytes.length };
        },
      },
    },
  } as unknown as BbPluginApi;
  return { bb, files, reads, writes, successfulWrites, seed };
}
function prepared(request: unknown) {
  return {
    request: mediaRequest.parse(request),
    target: { boardId: "main", nodeId: "hero", fingerprint: "saved-brief" },
  };
}

test("captured image bytes survive source edits and A to B to A reuses the original snapshot", async () => {
  const f = fake();
  f.seed("reference.png", "A");
  const input = prepared({ kind: "image", prompt: "Refine the hero", images: ["reference.png"] });
  const first = await captureCanvasInputs(f.bb, game, input);
  expect(generationImagePaths(first.request)).toEqual([snapshotA]);
  expect(first.target.imageRevisions).toEqual([{ path: "reference.png", sha256: shaA }]);
  f.seed("reference.png", "B");
  expect(f.files.get(`/games/orbit/${snapshotA}`)?.content).toBe("QQ==");
  const second = await captureCanvasInputs(f.bb, game, input);
  expect(generationImagePaths(second.request)).toEqual([snapshotB]);
  expect(second.target.imageRevisions).toEqual([{ path: "reference.png", sha256: shaB }]);
  f.seed("reference.png", "A");
  const third = await captureCanvasInputs(f.bb, game, input);
  expect(third).toEqual(first);
  expect(f.successfulWrites).toEqual([`/games/orbit/${snapshotA}`, `/games/orbit/${snapshotB}`]);
  expect(f.files.get(`/games/orbit/${snapshotA}`)?.content).toBe("QQ==");
  expect(f.files.get(`/games/orbit/${snapshotB}`)?.content).toBe("Qg==");
  expect(generationImagePaths(input.request)).toEqual(["reference.png"]);
});

test("duplicate paths and identical image bytes keep attachment order and write one snapshot", async () => {
  const f = fake();
  f.seed("shape.png", "A");
  f.seed("alias.png", "A");
  const input = prepared({
    kind: "image",
    prompt: "Refine the hero",
    images: ["shape.png", "alias.png", "shape.png"],
    imageReferenceKey: "1. Shape\n2. Alias\n3. Shape",
  });
  const result = await captureCanvasInputs(f.bb, game, input);
  expect(generationImagePaths(result.request)).toEqual([snapshotA, snapshotA, snapshotA]);
  expect(result.request).toMatchObject({
    prompt: "Refine the hero",
    imageReferenceKey: "1. Shape\n2. Alias\n3. Shape",
  });
  expect(result.target.imageRevisions).toEqual([
    { path: "shape.png", sha256: shaA },
    { path: "alias.png", sha256: shaA },
  ]);
  expect(f.reads.map(({ path }) => path)).toEqual([
    "/games/orbit/shape.png",
    "/games/orbit/alias.png",
  ]);
  expect(f.successfulWrites).toEqual([`/games/orbit/${snapshotA}`]);
  expect(f.writes).toEqual([
    {
      hostId: "remote-host",
      rootPath: "/games/orbit",
      path: `/games/orbit/${snapshotA}`,
      content: "QQ==",
      contentEncoding: "base64",
      expectedSha256: null,
      createParents: true,
    },
  ]);
  expect(await captureCanvasInputs(f.bb, game, input)).toEqual(result);
  expect(f.successfulWrites).toEqual([`/games/orbit/${snapshotA}`]);
  expect(
    f.reads.every(
      ({ hostId, rootPath }) => hostId === "remote-host" && rootPath === "/games/orbit",
    ),
  ).toBe(true);
});

test("a corrupt existing snapshot rejects without replacing its bytes", async () => {
  const f = fake();
  f.seed("reference.png", "A");
  f.seed(snapshotA, "corrupt");
  await expect(
    captureCanvasInputs(
      f.bb,
      game,
      prepared({ kind: "image", prompt: "Refine", images: ["reference.png"] }),
    ),
  ).rejects.toThrow("A saved generation input changed. No request was submitted.");
  expect(f.files.get(`/games/orbit/${snapshotA}`)?.content).toBe("Y29ycnVwdA==");
  expect(f.successfulWrites).toEqual([]);
});

const variants = [
  { kind: "image", prompt: "Refine", images: ["first.JPEG", "last.webp"] },
  { kind: "text", prompt: "Critique", images: ["first.JPEG", "last.webp"] },
  { kind: "video", prompt: "Animate", imagePath: "first.JPEG", endImagePath: "last.webp" },
  { kind: "model-3d", approvedImagePath: "first.JPEG" },
  { kind: "model-3d", approvedImagePath: "first.JPEG", views: { back: "last.webp" } },
] as const;
for (const request of variants) {
  const single = request.kind === "model-3d" && !("views" in request);
  test(`${request.kind}${"views" in request ? " multiview" : ""} snapshots only its effective image paths`, async () => {
    const f = fake();
    f.seed("first.JPEG", "A");
    f.seed("last.webp", "B");
    const result = await captureCanvasInputs(f.bb, game, prepared(request));
    const expected = [
      `canvas/inputs/${shaA}.jpg`,
      ...(single ? [] : [`canvas/inputs/${shaB}.webp`]),
    ];
    expect(generationImagePaths(result.request)).toEqual(expected);
    expect(result.request.kind).toBe(request.kind);
    expect(result.target.imageRevisions).toEqual([
      { path: "first.JPEG", sha256: shaA },
      ...(single ? [] : [{ path: "last.webp", sha256: shaB }]),
    ]);
    expect(f.successfulWrites).toEqual(expected.map((path) => `/games/orbit/${path}`));
  });
}

for (const kind of ["image", "text", "video"] as const) {
  test(`${kind} without image inputs preserves the request without file I/O`, async () => {
    const f = fake();
    const input = prepared({ kind, prompt: "Create a forest" });
    expect(await captureCanvasInputs(f.bb, game, input)).toBe(input);
    expect(f.reads).toEqual([]);
    expect(f.writes).toEqual([]);
  });
}

for (const invalid of [
  { path: "reference.gif", overrides: {} },
  { path: "reference.png", overrides: { contentEncoding: "utf8" as const } },
  { path: "reference.png", overrides: { sizeBytes: 14 * 1024 * 1024 + 1 } },
]) {
  test(`invalid image input rejects before snapshot writes: ${JSON.stringify(invalid)}`, async () => {
    const f = fake();
    f.seed(invalid.path, "A", invalid.overrides);
    await expect(
      captureCanvasInputs(
        f.bb,
        game,
        prepared({ kind: "image", prompt: "Refine", images: [invalid.path] }),
      ),
    ).rejects.toThrow("Generation image inputs must be PNG, JPEG or WebP files under 14 MiB.");
    expect(f.files.get(`/games/orbit/${invalid.path}`)?.content).toBe("QQ==");
    expect(f.successfulWrites).toEqual([]);
  });
}
