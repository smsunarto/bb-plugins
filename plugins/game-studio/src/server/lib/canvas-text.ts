import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-kit/core/instructions";
import { generationJob, runsOnBb, type GenerationJob } from "../../shared/generation.ts";
import { generationPrompt } from "../../shared/generation-prompt.ts";
import type { Game } from "../../shared/schema.ts";
import { recipes } from "../../shared/recipes.ts";
import { fileArgs, hostFile, withMedia, writeMedia, type Place } from "./media.ts";
import { studioHostContract } from "../../shared/host-contract.ts";

const instructions = instructionFiles(import.meta.url);
type BbRequest = Extract<GenerationJob["request"], { kind: "text" | "agent" }>;
const stagingDir = (jobId: string) => `canvas/staging/${jobId}`;
/** Briefs follow the target model's prompting guide; reviews judge inputs; others write node text. */
function taskInstructions(request: BbRequest, game: Game & Place, jobId: string) {
  if (request.kind === "agent")
    return instructions.read("canvas-agent", {
      inputs:
        [
          ...request.images.map((path, index) => `- Image ${index + 1}: ${hostFile(game, path)}`),
          ...request.files.map((path) => `- File: ${hostFile(game, path)}`),
        ].join("\n") || "(none beyond the step itself)",
      output: hostFile(game, stagingDir(jobId)),
      step: generationPrompt(request),
    });
  if (request.reviewOf)
    return instructions.read("canvas-review", {
      modelReview: request.files?.some((path) => /\.(glb|gltf)$/i.test(path))
        ? instructions.read("model-review", { gameId: game.id, rootPath: game.rootPath })
        : "",
      files: request.files
        ? request.files.map((path) => `- ${hostFile(game, path)}`).join("\n")
        : "(none)",
    });
  if (request.judgeOf) return instructions.read("canvas-judge");
  if (!request.briefFor) return instructions.read("canvas-text");
  const model = recipes.find((recipe) => recipe.id === request.briefFor)!.label;
  return instructions.read("canvas-brief", {
    model,
    guide: instructions.read(`prompting/${request.briefFor}`),
  });
}
function runTitle(request: BbRequest) {
  if (request.kind === "agent") {
    // The instruction's first line, without the Markdown that would show raw in a thread title.
    const line = request.prompt.trimStart().split("\n", 1)[0]!;
    return `Canvas agent: ${line
      .replace(/^(#{1,6}|[-*+]|\d+\.)\s+/, "")
      .replace(/[*_`]/g, "")
      .slice(0, 60)}`;
  }
  if (request.reviewOf) return "Canvas review";
  if (request.judgeOf) return "Canvas judge";
  return request.briefFor ? "Canvas brief" : "Canvas text";
}
/** BB owns provider discovery, authentication and execution; this owns the canvas job record. */
export class CanvasText {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly bb: BbPluginApi;
  constructor(bb: BbPluginApi) {
    this.bb = bb;
  }
  private async serial<T>(game: Game, id: string, action: () => Promise<T>) {
    const key = JSON.stringify([game.hostId, game.rootPath, id]);
    const next = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }
  private file(game: Place, path: string) {
    return fileArgs(game, path);
  }
  private async read(game: Game, id: string) {
    const file = await this.bb.sdk.files.read(this.file(game, `canvas/jobs/${id}.json`));
    return { job: generationJob.parse(JSON.parse(file.content)), revision: file.sha256 };
  }
  private async save(game: Game, job: GenerationJob, revision: string | null) {
    job.updatedAt = Date.now();
    const result = await this.bb.sdk.files.write({
      ...this.file(game, `canvas/jobs/${job.id}.json`),
      content: JSON.stringify(job, null, 2),
      contentEncoding: "utf8",
      expectedSha256: revision,
    });
    if (result.outcome === "conflict")
      throw new Error("The text job changed. Refresh its status before continuing.");
  }
  async start(checkout: Game, job: GenerationJob) {
    return this.serial(checkout, job.id, async () => {
      const game = await withMedia(this.bb, checkout);
      if (!runsOnBb(job.request)) throw new Error("A text or agent request is required.");
      const request = job.request;
      const providers = await this.bb.sdk.providers.list();
      const providerId = job.request.providerId;
      if (providerId && !providers.some((provider) => provider.id === providerId))
        throw new Error("The selected BB provider is unavailable.");
      const projects = await this.bb.sdk.projects.list({ includePersonal: true });
      const personal = projects.find((project) => project.kind === "personal");
      if (!personal && request.kind === "text")
        throw new Error("BB's personal workspace is unavailable for text generation.");
      const images = await Promise.all(
        request.images.map(async (path) => {
          const image = await this.bb.sdk.files.read(this.file(game, path));
          if (
            image.contentEncoding !== "base64" ||
            image.sizeBytes > 14 * 1024 * 1024 ||
            !/\.(png|jpe?g|webp)$/i.test(path)
          )
            throw new Error("Text image inputs must be PNG, JPEG or WebP files under 14 MiB.");
          const mime = /\.webp$/i.test(path)
            ? "image/webp"
            : /\.png$/i.test(path)
              ? "image/png"
              : "image/jpeg";
          return { type: "image" as const, url: `data:${mime};base64,${image.content}` };
        }),
      );
      const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
      const reservation = await client.call(
        "start",
        {
          rootPath: game.rootPath,
          jobId: job.id,
          threadId: job.threadId,
          origin: job.origin,
          request: job.request,
          ...(job.target ? { target: job.target } : {}),
        },
        { hostId: game.hostId },
      );
      if (!reservation.created) return reservation;
      // Resolved after the reservation, which holds off a move until the run is done.
      const placed = await withMedia(this.bb, checkout);
      const { revision } = await this.read(game, job.id);
      try {
        // An agent works in the game's checkout, in a thread the person can watch and steer.
        const place =
          request.kind === "agent"
            ? {
                projectId: game.projectId,
                environment: {
                  type: "host" as const,
                  hostId: game.hostId,
                  workspace: { type: "unmanaged" as const, path: game.rootPath },
                },
                visibility: "visible" as const,
              }
            : {
                projectId: personal!.id,
                environment: {
                  type: "host" as const,
                  hostId: game.hostId,
                  workspace: { type: "personal" as const },
                },
                visibility: "hidden" as const,
              };
        const task = await this.bb.sdk.threads.spawn({
          ...place,
          providerId: request.providerId,
          model: request.model.id,
          ...(request.reasoningLevel ? { reasoningLevel: request.reasoningLevel } : {}),
          ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
          origin: "plugin",
          originPluginId: "game-studio",
          title: request.kind === "agent" ? runTitle(request) : `${runTitle(request)} · ${job.id}`,
          pluginMetadata: { gameStudioJobId: job.id, gameStudioGameId: game.id },
          input: [
            {
              type: "text",
              mentions: [],
              text:
                request.kind === "agent"
                  ? taskInstructions(request, placed, job.id)
                  : `${taskInstructions(request, placed, job.id)}\n\n${generationPrompt(request)}`,
            },
            ...images,
          ],
        });
        job.taskId = task.id;
        job.status = "running";
      } catch (error) {
        this.bb.log.warn(
          `Could not confirm BB canvas text run: ${error instanceof Error ? error.message : String(error)}`,
        );
        job.status = "uncertain";
        job.detail =
          "BB could not confirm the text run. This request will not be submitted again automatically.";
      }
      await this.save(game, job, revision);
      return { created: true, job };
    });
  }
  async status(checkout: Game, id: string, cancel = false) {
    return this.serial(checkout, id, async () => {
      const game = await withMedia(this.bb, checkout);
      const { job, revision } = await this.read(game, id);
      if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
      const unchanged = JSON.stringify(job);
      if (!job.taskId) {
        job.status = "uncertain";
        job.detail =
          "No BB run identity was confirmed. Check the original run before making another request.";
      } else {
        if (cancel) {
          job.cancelRequested = true;
          // Persist intent before asking BB to stop; later polls must not adopt partial text.
          await this.save(game, job, revision);
          await this.bb.sdk.threads.stop({ threadId: job.taskId });
        }
        const task = await this.bb.sdk.threads.get({ threadId: job.taskId });
        if (job.cancelRequested) {
          job.status = ["active", "starting", "stopping", "pending"].includes(task.status)
            ? "uncertain"
            : "cancelled";
          job.detail =
            job.status === "uncertain"
              ? "Waiting for BB to confirm the run has stopped."
              : "Text generation cancelled.";
        } else if (task.status === "idle") {
          const result = await this.bb.sdk.threads.output({ threadId: job.taskId });
          const text = result.output?.trim();
          if (!text || text.length > 100000) {
            job.status = "failed";
            job.detail = "BB returned empty or oversized text.";
          } else {
            // An agent's report sits beside the files it made, which the host then collects.
            const path = `${stagingDir(job.id)}/${job.request.kind === "agent" ? "report.md" : "output.md"}`;
            await writeMedia(this.bb, game, path, async (args) => {
              const written = await this.bb.sdk.files.write({
                ...args,
                content: text,
                contentEncoding: "utf8",
                expectedSha256: null,
                createParents: true,
              });
              if (written.outcome === "conflict") {
                const existing = await this.bb.sdk.files.read(args);
                if (existing.content !== text)
                  throw new Error("The staged text was edited. Its newer content was preserved.");
              }
            });
            job.outputs =
              job.request.kind === "agent"
                ? await this.bb.hosts
                    .experimental_client({ contract: studioHostContract })
                    .call(
                      "stagedOutputs",
                      { rootPath: game.rootPath, jobId: job.id },
                      { hostId: game.hostId },
                    )
                : [
                    {
                      path,
                      type: "text",
                      sizeBytes: Buffer.byteLength(text),
                      sha256: createHash("sha256").update(text).digest("hex"),
                    },
                  ];
            job.status = "succeeded";
            delete job.detail;
          }
        } else if (task.status === "error") {
          job.status = "failed";
          job.detail =
            "The selected BB provider could not complete the text run. Check its sign-in and availability.";
        }
      }
      // A run still going changes nothing. Saving it anyway would wake every studio watching
      // the canvas, whose next read would save it again.
      if (!cancel && JSON.stringify(job) === unchanged) return job;
      await this.save(game, job, cancel ? (await this.read(game, id)).revision : revision);
      return job;
    });
  }
}
