import { expect, test } from "bun:test";
import { cliProviders, type Command } from "./providers.ts";
import { mediaRequest } from "../shared/generation.ts";

test("Midjourney receives the saved reference key and images in matching order", async () => {
  const commands: Command[] = [];
  const job = await cliProviders.midjourney!.submit({
    request: mediaRequest.parse({
      kind: "image",
      prompt: "Use Hero for shape and Palette for color",
      model: { provider: "midjourney" },
      images: ["hero.png", "palette.png"],
      imageReferenceKey:
        'Attached image references (in attachment order):\n1. ["Hero", "Shape study"]\n2. ["Palette"]',
    }),
    rootPath: "/game",
    outputPath: "/game/canvas/staging/test",
    imagePaths: ["/game/hero.png", "/game/palette.png"],
    signal: new AbortController().signal,
    run: async (command) => {
      commands.push(command);
      return {
        code: 0,
        stdout:
          command.args[0] === "doctor"
            ? "{}"
            : JSON.stringify({
                success: [{ job_id: "c184f39e-e9ed-4135-8ac3-2eedf3e1cfb8" }],
                failure: [],
              }),
        stderr: "",
      };
    },
    recordTask: async () => {},
  });
  expect(job).toBe("c184f39e-e9ed-4135-8ac3-2eedf3e1cfb8");
  expect(commands[1]!.args).toEqual([
    "imagine",
    'Use Hero for shape and Palette for color\n\nAttached image references (in attachment order):\n1. ["Hero", "Shape study"]\n2. ["Palette"]',
    "--model",
    "midjourney",
    "--speed",
    "fast",
    "--ar",
    "1:1",
    "--image",
    "/game/hero.png",
    "--image",
    "/game/palette.png",
    "--no-wait",
    "--json",
  ]);
});

test("Tripo receives each view under its own flag", async () => {
  const commands: Command[] = [];
  const task = await cliProviders.tripo!.submit({
    request: mediaRequest.parse({
      kind: "model-3d",
      approvedImagePath: "a.png",
      views: { back: "c.png", left: "b.webp" },
    }),
    rootPath: "/game",
    outputPath: "/game/canvas/staging/test",
    imagePaths: ["/game/a.png", "/game/b.webp", "/game/c.png"],
    signal: new AbortController().signal,
    run: async (command) => {
      commands.push(command);
      return {
        code: 0,
        stdout:
          command.args[0] === "doctor"
            ? "{}"
            : JSON.stringify({ task_id: "c184f39e-e9ed-4135-8ac3-2eedf3e1cfb8" }),
        stderr: "",
      };
    },
    recordTask: async () => {},
  });
  expect(task).toBe("c184f39e-e9ed-4135-8ac3-2eedf3e1cfb8");
  expect(commands[1]!.args).toEqual([
    "generate",
    "multiview-to-model",
    "--front",
    "/game/a.png",
    "--left",
    "/game/b.webp",
    "--back",
    "/game/c.png",
    "--model",
    "tripo-p2",
    "--param",
    "face_limit=20000",
    "--no-wait",
    "--no-open",
    "--json",
  ]);
});
