import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("Nano Banana uses the Interactions REST shape and authenticated headers", async () => {
  const { ctx, recorded } = await context({ kind: "image", prompt: "An icon" });
  const calls: { url: string; options?: RequestInit }[] = [];
  globalThis.fetch = (async (url, options) => {
    calls.push({ url: String(url), options });
    return response({
      id: "interaction-1",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "image",
              mime_type: "image/png",
              data: Buffer.from("image-output").toString("base64"),
            },
          ],
        },
      ],
    });
  }) as typeof fetch;
  const provider = cloudProviders({ googleApiKey: "test-google-secret" }).google!;
  const id = await provider.submit(ctx);
  await provider.collect(ctx, id);
  expect(recorded).toEqual(["interaction-1"]);
  expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
  expect(calls[0]!.options?.headers).toMatchObject({ "x-goog-api-key": "test-google-secret" });
  expect(JSON.parse(String(calls[0]!.options?.body))).toEqual({
    model: "gemini-nano-banana-2.1",
    input: [{ type: "text", text: "An icon" }],
    store: true,
    response_format: { type: "image", aspect_ratio: "1:1", image_size: "1K" },
  });
  expect(await readFile(join(ctx.outputPath, "output.png"), "utf8")).toBe("image-output");
  expect(calls.map((call) => call.options?.method)).toEqual(["POST", "GET"]);
});

test("Omni downloads a Google file with credentials kept off the CDN redirect", async () => {
  const { ctx } = await context({
    kind: "video",
    prompt: "A spinning coin",
    duration: 3,
    resolution: "360p",
  });
  const urls: string[] = [];
  const headers: unknown[] = [];
  globalThis.fetch = (async (url, options) => {
    const path = String(url);
    urls.push(path);
    headers.push(options?.headers);
    if (path.endsWith("/interactions")) {
      expect(JSON.parse(String(options?.body)).response_format).toEqual({
        type: "video",
        delivery: "uri",
        aspect_ratio: "16:9",
        duration: "3s",
        resolution: "360p",
      });
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
                uri: "https://generativelanguage.googleapis.com/v1beta/files/video1:download?alt=media",
              },
            ],
          },
        ],
      });
    }
    if (path.endsWith("/files/video1")) return response({ state: "ACTIVE" });
    if (path.includes(":download"))
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://storage.googleapis.com/generated/video.mp4?signature=example",
        },
      });
    if (path.startsWith("https://storage.googleapis.com/")) return new Response("video-output");
    throw new Error("Unexpected endpoint");
  }) as typeof fetch;
  await cloudProviders({ googleApiKey: "test-google-secret" }).google!.submit(ctx);
  expect(await readFile(join(ctx.outputPath, "output.mp4"), "utf8")).toBe("video-output");
  expect(urls).toHaveLength(4);
  expect(headers[3]).toBeUndefined();
});

test("Fal preserves server queue URLs, submits H3 Max once, and downloads without leaking the key", async () => {
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
  const provider = cloudProviders({ falApiKey: "test-fal-secret" }).fal!;
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
  let count = 0;
  globalThis.fetch = (async () => {
    count++;
    return new Response("secret-in-provider-error", { status: 403 });
  }) as typeof fetch;
  await expect(
    cloudProviders({ googleApiKey: "test-private-key" }).google!.submit(ctx),
  ).rejects.toThrow("HTTP 403");
  expect(count).toBe(1);
});
