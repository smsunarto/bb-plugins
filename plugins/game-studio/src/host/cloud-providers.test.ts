import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cloudProviders } from "./cloud-providers.ts";
import { mediaRequest } from "../shared/generation.ts";
import type { ProviderContext } from "./providers.ts";
const originalFetch = globalThis.fetch;
const roots: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function context(request: unknown) {
  const outputPath = await mkdtemp(join(tmpdir(), "studio-cloud-test-"));
  roots.push(outputPath);
  let providerData: Record<string, string> | undefined;
  const recorded: string[] = [];
  const ctx: ProviderContext = {
    rootPath: outputPath,
    locate: (path: string) => `${outputPath}/${path}`,
    outputPath,
    request: mediaRequest.parse(request),
    imagePaths: [],
    signal: new AbortController().signal,
    run: async () => {
      throw new Error("No shell calls for API providers");
    },
    get providerData() {
      return providerData;
    },
    recordTask: async (id, data) => {
      recorded.push(id);
      providerData = data;
    },
  };
  return { ctx, recorded };
}
const response = (body: unknown) => Response.json(body);

const vertex = { vertexProject: "studio-test-project" };
const signedIn = (ctx: ProviderContext, commands: string[][] = []) => {
  ctx.run = async (command) => {
    commands.push([command.executable, ...command.args]);
    return { code: 0, stdout: "ya29.test-token\n", stderr: "" };
  };
  return commands;
};

test("Nano Banana generates on Vertex AI with the host's ADC token and saves the image", async () => {
  const { ctx, recorded } = await context({ kind: "image", prompt: "An icon" });
  const commands = signedIn(ctx);
  const calls: { url: string; options?: RequestInit }[] = [];
  globalThis.fetch = (async (url, options) => {
    calls.push({ url: String(url), options });
    return response({
      responseId: "response-1",
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "image/png",
                  data: Buffer.from("image-output").toString("base64"),
                },
              },
            ],
          },
        },
      ],
    });
  }) as typeof fetch;
  const provider = cloudProviders(vertex).google!;
  const id = await provider.submit(ctx);
  await provider.collect(ctx, id);
  expect(id).toBe("response-1");
  expect(recorded).toEqual(["response-1"]);
  expect(commands).toEqual([["gcloud", "auth", "application-default", "print-access-token"]]);
  expect(calls.map((call) => call.url)).toEqual([
    "https://aiplatform.googleapis.com/v1/projects/studio-test-project/locations/global/publishers/google/models/gemini-nano-banana-2.1:generateContent",
  ]);
  expect(calls[0]!.options?.headers).toMatchObject({
    Authorization: "Bearer ya29.test-token",
    "x-goog-user-project": "studio-test-project",
  });
  expect(JSON.parse(String(calls[0]!.options?.body))).toEqual({
    contents: [{ role: "user", parts: [{ text: "An icon" }] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "1:1", imageSize: "1K" },
    },
  });
  expect(await readFile(join(ctx.outputPath, "output.png"), "utf8")).toBe("image-output");
});

test("Google receives ordered reference labels alongside the corresponding image bytes", async () => {
  const { ctx } = await context({
    kind: "image",
    prompt: "Refine the key silhouette using the palette.",
    images: ["references/shape.png", "references/palette.webp"],
    imageReferenceKey: `Attached image references (in attachment order):
1. ["Key shape (node: shape)", "Handle silhouette"]
2. ["Blue palette (asset: palette)"]`,
  });
  signedIn(ctx);
  const shape = join(ctx.rootPath, "shape.png"),
    palette = join(ctx.rootPath, "palette.webp");
  await writeFile(shape, "shape-image");
  await writeFile(palette, "palette-image");
  ctx.imagePaths = [shape, palette];
  let body: { contents: { parts: unknown[] }[] } | undefined;
  globalThis.fetch = (async (_url, options) => {
    body = JSON.parse(String(options?.body));
    return response({ responseId: "labelled", candidates: [{ finishReason: "IMAGE_SAFETY" }] });
  }) as typeof fetch;
  await expect(cloudProviders(vertex).google!.submit(ctx)).rejects.toThrow(
    "Nano Banana returned no single image (IMAGE_SAFETY).",
  );
  expect(body!.contents[0]!.parts).toEqual([
    { inlineData: { mimeType: "image/png", data: "c2hhcGUtaW1hZ2U=" } },
    { inlineData: { mimeType: "image/webp", data: "cGFsZXR0ZS1pbWFnZQ==" } },
    {
      text: `Refine the key silhouette using the palette.

Attached image references (in attachment order):
1. ["Key shape (node: shape)", "Handle silhouette"]
2. ["Blue palette (asset: palette)"]`,
    },
  ]);
});

test("Omni submits a background Vertex interaction and saves the polled inline video", async () => {
  const { ctx, recorded } = await context({
    kind: "video",
    prompt: "A spinning coin",
    duration: 5,
    resolution: "360p",
  });
  signedIn(ctx);
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  const interactions =
    "https://aiplatform.googleapis.com/v1beta1/projects/studio-test-project/locations/global/interactions";
  globalThis.fetch = (async (url, options) => {
    calls.push({
      url: String(url),
      method: options?.method,
      body: options?.body ? JSON.parse(String(options.body)) : undefined,
    });
    if (options?.method === "POST") return response({ id: "video-job", status: "in_progress" });
    return response({
      id: "video-job",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "video",
              mime_type: "video/mp4",
              data: Buffer.from("video-output").toString("base64"),
            },
          ],
        },
      ],
    });
  }) as typeof fetch;
  const provider = cloudProviders(vertex).google!;
  const id = await provider.submit(ctx);
  await provider.collect(ctx, id);
  expect(recorded).toEqual(["video-job"]);
  expect(calls).toEqual([
    {
      url: interactions,
      method: "POST",
      body: {
        model: "gemini-omni-1.1-flash-preview",
        input: [{ type: "text", text: "A spinning coin" }],
        background: true,
        store: true,
        response_format: [
          { type: "video", aspect_ratio: "16:9", duration: "5s", resolution: "360p" },
        ],
        generation_config: { video_config: { task: "text_to_video" } },
      },
    },
    { url: `${interactions}/video-job`, method: "GET", body: undefined },
  ]);
  expect(await readFile(join(ctx.outputPath, "output.mp4"), "utf8")).toBe("video-output");
});

test("Google requires a Vertex project and a host ADC sign-in before any request", async () => {
  const { ctx } = await context({ kind: "image", prompt: "An icon" });
  globalThis.fetch = (async () => {
    throw new Error("No network before authentication");
  }) as typeof fetch;
  await expect(cloudProviders({}).google!.submit(ctx)).rejects.toMatchObject({
    status: "auth-required",
    message: "Set the Google Cloud project for Vertex AI in Game Studio settings.",
  });
  ctx.run = async () => ({ code: 1, stdout: "", stderr: "Reauthentication required" });
  await expect(cloudProviders(vertex).google!.submit(ctx)).rejects.toMatchObject({
    status: "auth-required",
    message:
      "Sign in on this project's host with `gcloud auth application-default login`, then retry.",
  });
});

test("Fal preserves server queue URLs, submits H3 Max once, and downloads without leaking the OAuth token", async () => {
  const { ctx, recorded } = await context({
    kind: "video",
    prompt: "A coin",
    model: { provider: "fal", id: "minimax/h3-max/reference-to-video" },
    resolution: "768p",
  });
  const id = "c184f39e-e9ed-4135-8ac3-2eedf3e1cfb8";
  const statusUrl = `https://queue.fal.run/minimax/h3-max/requests/${id}/status`,
    resultUrl = `https://queue.fal.run/minimax/h3-max/requests/${id}`;
  const urls: string[] = [];
  globalThis.fetch = (async (url, options) => {
    const path = String(url);
    urls.push(path);
    if (path.startsWith("https://queue.fal.run/"))
      expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer test-fal-secret");
    if (options?.method === "POST") {
      expect(JSON.parse(String(options.body))).toMatchObject({
        prompt: "A coin",
        resolution: "768P",
        prompt_expansion_mode: "disabled",
      });
      return response({ request_id: id, status_url: statusUrl, response_url: resultUrl });
    }
    if (path === statusUrl) return response({ status: "COMPLETED" });
    if (path === resultUrl)
      return response({ video: { url: "https://v3.fal.media/files/video.mp4" } });
    expect(options?.headers).toBeUndefined();
    return new Response("fal-video");
  }) as typeof fetch;
  const provider = cloudProviders({ falAccessToken: "test-fal-secret" }).fal!;
  const taskId = await provider.submit(ctx);
  await provider.collect(ctx, taskId);
  expect(recorded).toEqual([id]);
  expect(urls).toEqual([
    "https://queue.fal.run/minimax/h3-max/reference-to-video",
    statusUrl,
    resultUrl,
    "https://v3.fal.media/files/video.mp4",
  ]);
  expect(await readFile(join(ctx.outputPath, "output.mp4"), "utf8")).toBe("fal-video");
});

test("a failed API request never exposes its raw error body or retries the paid POST", async () => {
  const { ctx } = await context({ kind: "image", prompt: "An icon" });
  signedIn(ctx);
  let count = 0;
  globalThis.fetch = (async () => {
    count++;
    return new Response("secret-in-provider-error", { status: 403 });
  }) as typeof fetch;
  await expect(cloudProviders(vertex).google!.submit(ctx)).rejects.toThrow("HTTP 403");
  expect(count).toBe(1);
});
