import { readFile, writeFile, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { ProviderFailure, type MediaProvider, type ProviderContext } from "./providers.ts";

export type Credentials = { googleApiKey?: string; falApiKey?: string };
const googleRoot = "https://generativelanguage.googleapis.com/v1beta/interactions";
const falRoot = "https://queue.fal.run/minimax/h3-max/reference-to-video";
const content = z.object({
  type: z.string(),
  data: z.string().optional(),
  mime_type: z.string().optional(),
  uri: z.string().optional(),
});
const interaction = z.object({
  id: z.string().min(1).max(200),
  status: z.string(),
  steps: z.array(z.object({ type: z.string(), content: z.array(content).optional() })).default([]),
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
      parsed.hostname.endsWith(".fal.ai") ||
      parsed.hostname === "storage.googleapis.com"
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

function requireKey(key: string | undefined, provider: string): string {
  if (!key)
    throw new ProviderFailure(
      `Configure ${provider}'s API key in Game Studio settings. No request was submitted.`,
      "auth-required",
    );
  return key;
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
      if (request.kind === "model-3d")
        throw new Error("Google does not generate 3D models through this adapter.");
      const headers = { "x-goog-api-key": requireKey(credentials.googleApiKey, "Google Gemini") };
      const frameRoles =
        request.kind === "video" && context.imagePaths.length
          ? `${context.imagePaths[1] ? "<FIRST_FRAME> <LAST_FRAME>" : "<FIRST_FRAME>"} `
          : "";
      const input = [
        ...(await Promise.all(context.imagePaths.map(image))),
        { type: "text", text: frameRoles + request.prompt },
      ];
      const result = interaction.parse(
        await jsonRequest(googleRoot, headers, context.signal, {
          model:
            request.model.id ??
            (request.kind === "image" ? "gemini-nano-banana-2.1" : "gemini-omni-1.1-flash"),
          input,
          store: true,
          response_format:
            request.kind === "image"
              ? { type: "image", aspect_ratio: request.aspectRatio, image_size: request.resolution }
              : {
                  type: "video",
                  delivery: "uri",
                  aspect_ratio: request.aspectRatio,
                  duration: `${request.duration}s`,
                  resolution: request.resolution,
                },
        }),
      );
      await context.recordTask(result.id);
      if (result.status === "completed")
        await saveGoogleMedia(context, result, headers["x-goog-api-key"]);
      return result.id;
    },
    async collect(context, taskId) {
      const headers = { "x-goog-api-key": requireKey(credentials.googleApiKey, "Google Gemini") };
      for (let attempt = 0; attempt < 120; attempt++) {
        const result = interaction.parse(
          await jsonRequest(`${googleRoot}/${encodeURIComponent(taskId)}`, headers, context.signal),
        );
        if (result.status === "completed") {
          await saveGoogleMedia(context, result, headers["x-goog-api-key"]);
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
          { Authorization: `Key ${requireKey(credentials.falApiKey, "Fal")}` },
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
      const headers = { Authorization: `Key ${requireKey(credentials.falApiKey, "Fal")}` };
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
async function saveGoogleMedia(
  context: ProviderContext,
  result: z.output<typeof interaction>,
  key: string,
) {
  const wanted = context.request.kind === "image" ? "image" : "video";
  const outputs = result.steps
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .filter((part) => part.type === wanted);
  if (outputs.length !== 1)
    throw new ProviderFailure(
      "Google returned no single complete media output. Its interaction identity was saved.",
      "uncertain",
      result.id,
    );
  const output = outputs[0]!;
  const extension =
    wanted === "video"
      ? "mp4"
      : output.mime_type === "image/jpeg"
        ? "jpg"
        : output.mime_type === "image/webp"
          ? "webp"
          : "png";
  const path = join(context.outputPath, `output.${extension}`);
  if (output.data) await saveOutput(path, Buffer.from(output.data, "base64"));
  else if (output.uri) await downloadGoogle(output.uri, path, context.signal, key);
  else
    throw new ProviderFailure(
      "Google returned an incomplete media output.",
      "uncertain",
      result.id,
    );
}

async function downloadGoogle(uri: string, path: string, signal: AbortSignal, key: string) {
  const url = new URL(uri);
  const match = /^\/v1beta\/files\/([a-zA-Z0-9_-]+)(?::download)?$/.exec(url.pathname);
  if (
    url.origin !== "https://generativelanguage.googleapis.com" ||
    !match ||
    url.username ||
    url.password
  )
    throw new Error("Google returned an unexpected media URI.");
  const fileUrl = `https://generativelanguage.googleapis.com/v1beta/files/${match[1]}`;
  const headers = { "x-goog-api-key": key };
  for (let attempt = 0; attempt < 120; attempt++) {
    const file = z
      .object({ state: z.enum(["ACTIVE", "PROCESSING", "FAILED"]) })
      .parse(await jsonRequest(fileUrl, headers, signal));
    if (file.state === "FAILED")
      throw new ProviderFailure("Google could not process the generated video.", "failed");
    if (file.state === "ACTIVE") {
      // Never forward credentials to redirected download origins.
      const response = await fetch(`${fileUrl}:download?alt=media`, {
        headers,
        signal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("Google returned an empty download redirect.");
        await download(location, path, signal);
        return;
      }
      if (!response.ok)
        throw new ProviderFailure(
          "Google media download failed. Resume the saved job.",
          "uncertain",
        );
      await saveOutput(path, await boundedBody(response, 512 * 1024 * 1024));
      return;
    }
    await setTimeout(5000, undefined, { signal });
  }
  throw new ProviderFailure("Google media is still processing. Resume the saved job.", "uncertain");
}
