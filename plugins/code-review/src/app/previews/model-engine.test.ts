import { expect, test } from "bun:test";
import { siblingPath } from "./model-engine.ts";

test("a file a model names is read beside it, and never outside the repository", () => {
  expect(siblingPath("Models/house.gltf", "house.bin")).toBe("Models/house.bin");
  expect(siblingPath("Models/house.obj", "../Textures/wood%20grain.png")).toBe(
    "Textures/wood grain.png",
  );
  // An exporter's absolute path means the file beside the model.
  expect(siblingPath("Models/house.fbx", "C:\\Users\\artist\\wood.png")).toBe("Models/wood.png");
  expect(siblingPath("house.gltf", "../../etc/passwd")).toBeNull();
  // A URL that names a directory names no file to read, here or anywhere.
  expect(siblingPath("house.gltf", "https://tracker.example/x/")).toBeNull();
});
