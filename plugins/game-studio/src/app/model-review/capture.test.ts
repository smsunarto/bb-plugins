import { expect, test } from "bun:test";
import type { ModelEvidenceInput } from "../../shared/model-review.ts";
import { captureShots } from "./capture.ts";
import type { ReviewEngine } from "./engine.ts";

// Bun has no FileReader; the browser one reads a Blob into a data URL.
class DataUrlReader extends EventTarget {
  result = "";
  error = null;
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((bytes) => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.dispatchEvent(new Event("load"));
      return undefined;
    });
  }
}
globalThis.FileReader = DataUrlReader as unknown as typeof FileReader;

function engine(selfContained: boolean) {
  return {
    selfContained,
    modelSha256: "a".repeat(64),
    stats: { clips: [] },
    view() {},
    resize() {},
    renderAt() {},
    png: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
  } as unknown as ReviewEngine;
}
const script = { width: 64, height: 64, shots: [{ name: "front", camera: "front" }] };
const signal = new AbortController().signal;

test("a model with external files is refused before any capture is saved", async () => {
  const saved: ModelEvidenceInput[] = [];
  const save = async (input: ModelEvidenceInput) => {
    saved.push(input);
    return { runId: input.runId, files: [] };
  };
  await expect(
    captureShots(engine(false), script, "canvas/model.gltf", "game", save, () => {}, signal),
  ).rejects.toThrow("self-contained");
  expect(saved).toEqual([]);
});

test("a finish that fails once is retried for the same run instead of rendering again", async () => {
  const saved: ModelEvidenceInput[] = [];
  const save = async (input: ModelEvidenceInput) => {
    saved.push(input);
    if (input.action === "finish" && saved.filter((item) => item.action === "finish").length === 1)
      throw new Error("The connection dropped");
    return { runId: input.runId, files: ["front.png"] };
  };
  const result = await captureShots(
    engine(true),
    script,
    "canvas/model.glb",
    "game",
    save,
    () => {},
    signal,
  );
  expect(saved.map((item) => item.action)).toEqual(["file", "finish", "finish"]);
  expect(new Set(saved.map((item) => item.runId))).toEqual(new Set([result.runId]));
});

test("progress only moves forward and reaches 1 once every shot is saved", async () => {
  const shares: number[] = [];
  const save = async (input: ModelEvidenceInput) => ({
    runId: input.runId,
    files: ["front.png", "top.png"],
  });
  await captureShots(
    engine(true),
    { ...script, shots: [script.shots[0]!, { name: "top", camera: "top" }] },
    "canvas/model.glb",
    "game",
    save,
    (_, done) => shares.push(done),
    signal,
  );
  expect(shares).toEqual([0.5, 1, 1]);
});
