import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { appendEvidence, saveModelEvidence } from "./model-evidence.ts";
import { parseShotScript } from "../../shared/model-review.ts";
const runId = "a2a68f00-789d-4bb2-bd12-df5a712ef10d";
const run = { id: runId, capturedAtMs: 1, files: [`canvas/evidence/${runId}/front.png`] };
test("append preserves existing run metadata and retries are idempotent", () => {
  const old = {
    id: "existing",
    capturedAtMs: 0,
    files: ["canvas/evidence/old.png"],
    custom: "keep",
  };
  const manifest = appendEvidence({ version: 1, runs: [old], custom: "keep" }, run);
  expect(manifest.runs[0]).toEqual(old);
  expect(appendEvidence(manifest, run)).toEqual(manifest);
  expect(() => appendEvidence(manifest, { ...run, files: ["other"] })).toThrow();
  expect(() => appendEvidence({ version: 1, runs: [run, run] }, run)).toThrow();
});
function fixture() {
  const files = new Map<
    string,
    { content: string; contentEncoding: "base64" | "utf8"; sha256: string }
  >();
  let collide = false;
  const seed = (path: string, content: string, contentEncoding: "base64" | "utf8" = "utf8") =>
    files.set(path, {
      content,
      contentEncoding,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  const game = {
    id: "game",
    name: "Test",
    projectId: "p",
    hostId: "h",
    rootPath: "/game",
    kind: "general",
    createdAt: 1,
    threadId: null,
    previewPath: "index.html",
  };
  const bb = {
    storage: { kv: { get: async () => game } },
    sdk: {
      files: {
        read: async ({ path }: { path: string }) => {
          const f = files.get(path);
          if (!f) throw new Error("HTTP 404: Path does not exist");
          return f;
        },
        write: async ({
          path,
          content,
          contentEncoding,
          expectedSha256,
        }: {
          path: string;
          content: string;
          contentEncoding: "base64" | "utf8";
          expectedSha256: string | null;
        }) => {
          if (collide && path.endsWith("index.json")) {
            collide = false;
            seed(
              path,
              JSON.stringify({
                version: 1,
                runs: [
                  { id: "external", capturedAtMs: 0, files: ["canvas/evidence/external.png"] },
                ],
              }),
            );
          }
          if ((files.get(path)?.sha256 ?? null) !== expectedSha256) return { outcome: "conflict" };
          seed(path, content, contentEncoding);
          return { outcome: "written", sha256: files.get(path)!.sha256 };
        },
      },
    },
  } as unknown as BbPluginApi;
  seed("/game/canvas/staging/model.glb", "model");
  return {
    bb,
    files,
    seed,
    conflict: () => {
      collide = true;
    },
  };
}
test("completion verifies captures, persists source provenance, and merges a concurrent writer", async () => {
  const f = fixture();
  const script = parseShotScript({ shots: [{ name: "front" }] });
  const finish = {
    action: "finish" as const,
    gameId: "game",
    runId,
    model: "canvas/staging/model.glb",
    modelSha256: createHash("sha256").update("model").digest("hex"),
    script,
  };
  await expect(saveModelEvidence(f.bb, finish)).rejects.toThrow("Path does not exist");
  f.seed(`/game/${run.files[0]}`, "image", "base64");
  f.conflict();
  expect(await saveModelEvidence(f.bb, finish)).toEqual({ runId, files: run.files });
  expect(
    JSON.parse(f.files.get("/game/canvas/evidence/index.json")!.content).runs.map(
      (r: { id: string }) => r.id,
    ),
  ).toEqual(["external", runId]);
  expect(
    JSON.parse(f.files.get(`/game/canvas/evidence/${runId}/shots.json`)!.content),
  ).toHaveProperty("modelSha256");
  await saveModelEvidence(f.bb, finish);
  expect(JSON.parse(f.files.get("/game/canvas/evidence/index.json")!.content).runs).toHaveLength(2);
});
test("capture uploads cannot overwrite and reject invalid media", async () => {
  const f = fixture();
  const input = {
    action: "file" as const,
    gameId: "game",
    runId,
    name: "front.png",
    content: Buffer.from("invalid").toString("base64"),
  };
  await expect(saveModelEvidence(f.bb, input)).rejects.toThrow("extension");
  input.content = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  await saveModelEvidence(f.bb, input);
  await expect(saveModelEvidence(f.bb, input)).rejects.toThrow("already exists");
});

test("a model changed since loading cannot receive stale rendered evidence", async () => {
  const f = fixture();
  f.seed(`/game/${run.files[0]}`, "image", "base64");
  const input = {
    action: "finish" as const,
    gameId: "game",
    runId,
    model: "canvas/staging/model.glb",
    modelSha256: createHash("sha256").update("earlier model").digest("hex"),
    script: parseShotScript({ shots: [{ name: "front" }] }),
  };
  await expect(saveModelEvidence(f.bb, input)).rejects.toThrow("Model changed");
  expect(f.files.has("/game/canvas/evidence/index.json")).toBe(false);
});
