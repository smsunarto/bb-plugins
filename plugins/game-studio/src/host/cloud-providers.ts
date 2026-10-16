import { readFile, readdir, writeFile, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { ProviderFailure, type MediaProvider, type ProviderContext } from "./providers.ts";
import { generationPrompt } from "../shared/generation-prompt.ts";

export type Credentials = { vertexProject?: string; falAccessToken?: string };
const vertexRoot = "https://aiplatform.googleapis.com";
const falRoot = "https://queue.fal.run/minimax/h3-max/reference-to-video";
const content = z.object({
  type: z.string(),
  data: z.string().optional(),
  mime_type: z.string().optional(),
});
const interaction = z.object({
  id: z.string().min(1).max(200),
  status: z.string(),
  steps: z.array(z.object({ type: z.string(), content: z.array(content).optional() })).default([]),
});
const generatedContent = z.object({
  responseId: z.string().min(1).max(200),
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z
          .object({
            parts: z
              .array(
                z.object({
                  inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional(),
                }),
              )
              .default([]),
          })
          .optional(),
      }),
    )
    .default([]),
});
const falReceipt = z.object({ request_id: z.uuid(), status_url: z.url(), response_url: z.url() });
const falStatus = z.object({
  status: z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]),
  error: z.string().optional(),
});
const falResult = z.object({ video: z.object({ url: z.url() }) });

async function jsonRequest(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  body?: object,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { ...headers, "Content-Type": "application/json" },
      signal,
      redirect: "error",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    signal.throwIfAborted();
    throw new ProviderFailure(
      "The provider connection failed. Check the saved job before submitting another request.",
      "uncertain",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderFailure(
      `The provider returned HTTP ${response.status}.`,
      response.status === 401 || response.status === 403
        ? "auth-required"
        : response.status >= 500
          ? "uncertain"
          : "failed",
    );
  }
  if (Number(response.headers.get("content-length")) > 256 * 1024 * 1024)
    throw new Error("Provider response exceeds 256 MiB.");
  const bytes = await boundedBody(response, 256 * 1024 * 1024);
  return JSON.parse(bytes.toString("utf8"));
}
async function image(path: string) {
  if ((await stat(path)).size > 14 * 1024 * 1024)
    throw new Error("Each image reference must fit within 14 MiB.");
  const bytes = await readFile(path);
  if (bytes.length > 14 * 1024 * 1024)
    throw new Error("Each image reference must fit within 14 MiB.");
  const mime = /\.png$/i.test(path)
    ? "image/png"
    : /\.webp$/i.test(path)
      ? "image/webp"
      : "image/jpeg";
  return { type: "image" as const, data: bytes.toString("base64"), mime_type: mime };
}
async function download(url: string, destination: string, signal: AbortSignal) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !(
      parsed.hostname.endsWith(".fal.media") ||
      parsed.hostname === "fal.media" ||
      parsed.hostname.endsWith(".fal.ai")
    )
  )
    throw new Error("The provider returned an unsupported media download origin.");
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok)
    throw new ProviderFailure(
      "The media download failed. Resume this saved job to recover it.",
      "uncertain",
    );
  await saveOutput(destination, await boundedBody(response, 512 * 1024 * 1024));
}
async function boundedBody(response: Response, limit: number) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (!response.body) throw new Error("The provider returned no response body.");
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("The provider response exceeds the local size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function saveOutput(path: string, bytes: Buffer) {
  await writeFile(`${path}.part`, bytes);
  await rename(`${path}.part`, path);
}

/** Vertex AI requires Application Default Credentials from the project's host. */
async function vertexAccess(credentials: Credentials, context: ProviderContext) {
  const project = credentials.vertexProject;
  if (!project)
    throw new ProviderFailure(
      "Set the Google Cloud project for Vertex AI in Game Studio settings.",
      "auth-required",
    );
  const signIn =
    "Sign in on this project's host with `gcloud auth application-default login`, then retry.";
  let result: Awaited<ReturnType<ProviderContext["run"]>>;
  try {
    result = await context.run({
      executable: "gcloud",
      args: ["auth", "application-default", "print-access-token"],
      cwd: context.rootPath,
      signal: context.signal,
    });
  } catch {
    context.signal.throwIfAborted();
    throw new ProviderFailure(`Install the Google Cloud CLI. ${signIn}`, "auth-required");
  }
  const token = result.stdout.trim();
  if (result.code !== 0 || !/^[\w.~+/-]+=*$/.test(token))
    throw new ProviderFailure(signIn, "auth-required");
  return {
    project,
    interactions: `${vertexRoot}/v1beta1/projects/${project}/locations/global/interactions`,
    headers: { Authorization: `Bearer ${token}`, "x-goog-user-project": project },
  };
}
function falAuthorization(credentials: Credentials): string {
  if (!credentials.falAccessToken)
    throw new ProviderFailure(
      "Connect Fal through Game Studio browser sign-in. No request was submitted.",
      "auth-required",
    );
  return `Bearer ${credentials.falAccessToken}`;
}
function queueUrl(url: string) {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://queue.fal.run" ||
    !parsed.pathname.startsWith("/minimax/h3-max/") ||
    parsed.username ||
    parsed.password ||
    parsed.search
  )
    throw new Error("Fal returned an unexpected queue URL.");
  return url;
}

/** Native API adapters share the same lifecycle as CLI-backed providers. */
export function cloudProviders(credentials: Credentials): Readonly<Record<string, MediaProvider>> {
  const google: MediaProvider = {
    async submit(context) {
      const request = context.request;
      if (request.kind === "model-3d" || request.kind === "text")
        throw new Error("Google does not generate 3D models through this adapter.");
      const vertex = await vertexAccess(credentials, context);
      const refs = await Promise.all(context.imagePaths.map(image));
      if (request.kind === "image") {
        const result = generatedContent.parse(
          await jsonRequest(
            `${vertexRoot}/v1/projects/${vertex.project}/locations/global/publishers/google/models/gemini-nano-banana-2.1:generateContent`,
            vertex.headers,
            context.signal,
            {
              contents: [
                {
                  role: "user",
                  parts: [
                    ...refs.map((ref) => ({
                      inlineData: { mimeType: ref.mime_type, data: ref.data },
                    })),
                    { text: generationPrompt(request) },
                  ],
                },
              ],
              generationConfig: {
                responseModalities: ["IMAGE"],
                imageConfig: { aspectRatio: request.aspectRatio, imageSize: request.resolution },
              },
            },
          ),
        );
        await context.recordTask(result.responseId);
        const images = result.candidates
          .flatMap((candidate) => candidate.content?.parts ?? [])
          .flatMap((part) => (part.inlineData ? [part.inlineData] : []));
        if (images.length !== 1)
          throw new ProviderFailure(
            `Nano Banana returned no single image (${result.candidates[0]?.finishReason ?? "no candidate"}).`,
            "failed",
            result.responseId,
          );
        await saveGoogleMedia(context, images[0]!.mimeType, images[0]!.data);
        return result.responseId;
      }
      const frameRoles = refs.length
        ? `${refs[1] ? "<FIRST_FRAME> <LAST_FRAME>" : "<FIRST_FRAME>"} `
        : "";
      const result = interaction.parse(
        await jsonRequest(vertex.interactions, vertex.headers, context.signal, {
          model: "gemini-omni-1.1-flash-preview",
          input: [...refs, { type: "text", text: frameRoles + generationPrompt(request) }],
          background: true,
          store: true,
          response_format: [
            {
              type: "video",
              aspect_ratio: request.aspectRatio,
              duration: `${request.duration}s`,
              resolution: request.resolution,
            },
          ],
          generation_config: {
            video_config: { task: refs.length ? "image_to_video" : "text_to_video" },
          },
        }),
      );
      await context.recordTask(result.id);
      return result.id;
    },
    async collect(context, taskId) {
      // Images are saved by their synchronous request; only video interactions poll.
      if (context.request.kind === "image") {
        if (await hasOutput(context.outputPath)) return;
        throw new ProviderFailure(
          "This Nano Banana image was not saved and cannot be recovered. Generate it again.",
          "failed",
          taskId,
        );
      }
      const vertex = await vertexAccess(credentials, context);
      for (let attempt = 0; attempt < 120; attempt++) {
        const result = interaction.parse(
          await jsonRequest(
            `${vertex.interactions}/${encodeURIComponent(taskId)}`,
            vertex.headers,
            context.signal,
          ),
        );
        if (result.status === "completed") {
          const videos = result.steps
            .filter((step) => step.type === "model_output")
            .flatMap((step) => step.content ?? [])
            .filter((part) => part.type === "video");
          if (videos.length !== 1 || !videos[0]!.data)
            throw new ProviderFailure(
              "Google returned no single complete video. Its interaction identity was saved.",
              "uncertain",
              taskId,
            );
          await saveGoogleMedia(context, "video/mp4", videos[0]!.data);
          return;
        }
        if (result.status !== "in_progress")
          throw new ProviderFailure(
            `Google generation ended with status ${result.status}.`,
            "failed",
            taskId,
          );
        await setTimeout(5000, undefined, { signal: context.signal });
      }
      throw new ProviderFailure(
        "Google generation is still pending. Resume this saved job to continue waiting.",
        "uncertain",
        taskId,
      );
    },
  };
  const fal: MediaProvider = {
    async submit(context) {
      const request = context.request;
      if (request.kind !== "video") throw new Error("H3 Max generates video.");
      const refs = await Promise.all(context.imagePaths.map(image));
      const dataUri = (ref: (typeof refs)[number]) => `data:${ref.mime_type};base64,${ref.data}`;
      const result = falReceipt.parse(
        await jsonRequest(
          falRoot,
          { Authorization: falAuthorization(credentials) },
          context.signal,
          {
            prompt: request.prompt,
            prompt_expansion_mode: "disabled",
            duration: request.duration,
            resolution: (request.resolution ?? "768p").toUpperCase(),
            aspect_ratio: request.aspectRatio,
            ...(refs[0] ? { image_url: dataUri(refs[0]) } : {}),
            ...(refs[1] ? { end_image_url: dataUri(refs[1]) } : {}),
          },
        ),
      );
      await context.recordTask(result.request_id, {
        statusUrl: queueUrl(result.status_url),
        resultUrl: queueUrl(result.response_url),
      });
      return result.request_id;
    },
    async collect(context, taskId) {
      const headers = { Authorization: falAuthorization(credentials) };
      const statusUrl = queueUrl(
        context.providerData?.statusUrl ??
          `${falRoot}/requests/${encodeURIComponent(taskId)}/status`,
      );
      const resultUrl = queueUrl(
        context.providerData?.resultUrl ??
          `${falRoot}/requests/${encodeURIComponent(taskId)}/response`,
      );
      for (let attempt = 0; attempt < 120; attempt++) {
        const status = falStatus.parse(await jsonRequest(statusUrl, headers, context.signal));
        if (status.status === "COMPLETED") {
          if (status.error)
            throw new ProviderFailure(
              "Fal reported that this generation failed.",
              "failed",
              taskId,
            );
          const result = falResult.parse(await jsonRequest(resultUrl, headers, context.signal));
          await download(result.video.url, join(context.outputPath, "output.mp4"), context.signal);
          return;
        }
        await setTimeout(5000, undefined, { signal: context.signal });
      }
      throw new ProviderFailure(
        "Fal generation is still pending. Resume this saved job to continue waiting.",
        "uncertain",
        taskId,
      );
    },
  };
  return { google, fal };
}
async function saveGoogleMedia(context: ProviderContext, mime: string, data: string) {
  const extension =
    mime === "video/mp4"
      ? "mp4"
      : mime === "image/jpeg"
        ? "jpg"
        : mime === "image/webp"
          ? "webp"
          : "png";
  await saveOutput(join(context.outputPath, `output.${extension}`), Buffer.from(data, "base64"));
}
async function hasOutput(path: string) {
  return (await readdir(path)).some((name) => name.startsWith("output."));
}
