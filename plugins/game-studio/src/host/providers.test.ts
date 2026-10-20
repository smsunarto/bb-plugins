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

const tripoTask = (id: string) => JSON.stringify({ task_id: id });
const importTask = "11111111-1111-4111-8111-111111111111",
  editTask = "22222222-2222-4222-8222-222222222222";
async function edit(request: unknown, imagePaths: string[] = []) {
  const commands: Command[] = [];
  const task = await cliProviders.tripo!.submit({
    request: mediaRequest.parse(request),
    rootPath: "/game",
    outputPath: "/game/canvas/staging/test",
    imagePaths,
    signal: new AbortController().signal,
    run: async (command) => {
      commands.push(command);
      const stdout =
        command.args[0] === "doctor"
          ? "{}"
          : tripoTask(command.args[1] === "import" ? importTask : editTask);
      return { code: 0, stdout, stderr: "" };
    },
    recordTask: async () => {},
  });
  return { task, commands: commands.slice(1).map(({ args }) => args) };
}

test("Tripo imports a model made elsewhere, then textures that task from its views", async () => {
  const { task, commands } = await edit(
    {
      kind: "model-edit",
      operation: "texture",
      sourcePath: "canvas/staging/cleanup/shark.glb",
      views: { front: "canvas/inputs/front.png", back: "canvas/inputs/back.png" },
      textureQuality: "detailed",
    },
    ["/game/canvas/inputs/front.png", "/game/canvas/inputs/back.png"],
  );
  expect(task).toBe(editTask);
  expect(commands).toEqual([
    [
      "model",
      "import",
      "/game/canvas/staging/cleanup/shark.glb",
      "--no-download",
      "--timeout",
      "600",
      "--no-open",
      "--json",
    ],
    [
      "model",
      "texture",
      importTask,
      "--param",
      'images=["/game/canvas/inputs/front.png",null,"/game/canvas/inputs/back.png",null]',
      "--texture-quality",
      "detailed",
      "--no-wait",
      "--no-open",
      "--json",
    ],
  ]);
});

test("Tripo rigs and animates the task that made the model, without importing it again", async () => {
  const rig = await edit({
    kind: "model-edit",
    operation: "rig",
    sourcePath: "canvas/staging/pbr/shark.glb",
    sourceTaskId: "pbr-task",
    rigType: "aquatic",
  });
  expect(rig.commands).toEqual([
    ["anim", "rig", "pbr-task", "--rig-type", "aquatic", "--no-wait", "--no-open", "--json"],
  ]);
  const animate = await edit({
    kind: "model-edit",
    operation: "animate",
    sourcePath: "canvas/staging/rig/shark.glb",
    sourceTaskId: "rig-task",
    animation: "preset:aquatic:march",
  });
  expect(animate.commands[0]).toEqual([
    "anim",
    "retarget",
    "rig-task",
    "--animation",
    "preset:aquatic:march",
    "--no-wait",
    "--no-open",
    "--json",
  ]);
});

test("a Tripo step the CLI rejects before submitting fails with its reason, safe to run again", async () => {
  const failure = await cliProviders
    .tripo!.submit({
      request: mediaRequest.parse({
        kind: "model-edit",
        operation: "rig",
        sourcePath: "canvas/staging/pbr/shark.glb",
        sourceTaskId: "pbr-task",
        rigType: "aquatic",
      }),
      rootPath: "/game",
      outputPath: "/game/canvas/staging/test",
      imagePaths: [],
      signal: new AbortController().signal,
      run: async (command) =>
        command.args[0] === "doctor"
          ? { code: 0, stdout: "{}", stderr: "" }
          : {
              code: 2,
              stdout:
                '{"error":"Requested rig_type does not match Studio\'s rig check.","exit_code":2}',
              stderr: "Billing: Tripo Studio web credits.",
            },
      recordTask: async () => {},
    })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({
    status: "failed",
    message:
      "Requested rig_type does not match Studio's rig check. Change the node and run it again.",
  });
});

test("an Animate step exports the rigged model with its clip once, even after a resume", async () => {
  const request = mediaRequest.parse({
    kind: "model-edit",
    operation: "animate",
    sourcePath: "canvas/staging/rig/shark.glb",
    sourceTaskId: "rig-task",
    animation: "preset:aquatic:march",
  });
  const exportTask = "33333333-3333-4333-8333-333333333333";
  const commands: string[][] = [];
  let recorded: Record<string, string> | undefined;
  const collect = (providerData?: Record<string, string>) =>
    cliProviders.tripo!.collect(
      {
        request,
        rootPath: "/game",
        outputPath: "/game/canvas/staging/test",
        imagePaths: [],
        signal: new AbortController().signal,
        providerData,
        run: async ({ args }) => {
          commands.push(args);
          return {
            code: 0,
            stdout: args[1] === "convert" ? tripoTask(exportTask) : "{}",
            stderr: "",
          };
        },
        recordTask: async (_id, data) => {
          recorded = data;
        },
      },
      "retarget-task",
    );
  await collect();
  expect(commands).toEqual([
    ["task", "watch", "retarget-task", "--timeout", "600", "--no-open", "--json"],
    ["model", "convert", "retarget-task", "--format", "GLTF", "--no-wait", "--no-open", "--json"],
    [
      "task",
      "watch",
      exportTask,
      "--download",
      "--out",
      "/game/canvas/staging/test",
      "--timeout",
      "600",
      "--no-open",
      "--json",
    ],
  ]);
  expect(recorded).toEqual({ exportTask });
  commands.length = 0;
  await collect(recorded);
  expect(commands.map((args) => args.slice(0, 3))).toEqual([["task", "watch", exportTask]]);
  commands.length = 0;
  await expect(collect({ exportState: "submitting" })).rejects.toMatchObject({
    status: "uncertain",
  });
  expect(commands).toEqual([]);
});
