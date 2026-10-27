import { expect, test } from "bun:test";
import { contentTypeOf, previewOf } from "./previews.ts";

test("previews are chosen by extension, whatever its case", () => {
  expect(previewOf("Art/Hero.PNG")).toEqual({ kind: "image", format: "png", decoded: null });
  expect(previewOf("Art/Hero.tga")).toEqual({ kind: "image", format: "tga", decoded: "tga" });
  expect(previewOf("Art/Hero.psd")).toMatchObject({ decoded: "psd" });
  expect(previewOf("Models/Hero.FBX")).toEqual({ kind: "model", format: "fbx" });
  expect(previewOf("Audio/hit.wav")).toEqual({ kind: "audio", format: "wav" });
  expect(previewOf("Fonts/Body.woff2")).toEqual({ kind: "font", format: "woff2" });
  expect(previewOf("Assets/Main.unity")).toEqual({ kind: "unity", label: "Scene" });
  expect(previewOf("Assets/Skin.mat")).toEqual({ kind: "unity", label: "Material" });
  expect(previewOf("Assets/Skin.mat.meta")).toEqual({ kind: "unity-meta" });
  expect(previewOf("src/app.ts")).toBeNull();
  expect(previewOf("Makefile")).toBeNull();
});

test("content types come from the same table, and anything else is opaque", () => {
  expect(contentTypeOf("a.svg")).toBe("image/svg+xml");
  expect(contentTypeOf("a.glb")).toBe("model/gltf-binary");
  expect(contentTypeOf("a.prefab")).toBe("text/plain; charset=utf-8");
  expect(contentTypeOf("a.html")).toBe("application/octet-stream");
});
