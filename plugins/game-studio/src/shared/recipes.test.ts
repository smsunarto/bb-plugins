import { expect, test } from "bun:test";
import { nodeInputPorts, outputPort } from "./recipes.ts";

test("each node accepts the inputs its model reads", () => {
  const ports = (type: Parameters<typeof nodeInputPorts>[0]["type"], recipe?: string) =>
    nodeInputPorts({ type, data: recipe ? { recipe } : {} });
  expect(ports("text")).toEqual({ text: Infinity, image: 14 });
  expect(ports("image")).toEqual({ text: Infinity, image: 14 });
  expect(ports("video", "fal-video")).toEqual({ text: Infinity, image: 2 });
  expect(ports("model-3d")).toEqual({ image: 14 });
  expect(ports("asset", "music")).toEqual({ text: Infinity });
  expect(ports("document")).toEqual({});
});

test("text and documents feed text ports; images feed image ports", () => {
  expect(
    ["text", "document", "image", "video", "model-3d"].map((kind) => outputPort(kind as never)),
  ).toEqual(["text", "text", "image", undefined, undefined]);
});
