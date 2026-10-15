import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-kit/core/instructions";
import { generationJob, type GenerationJob } from "../../shared/generation.ts";
import type { Game } from "../../shared/schema.ts";
import { projectFile } from "./paths.ts";
import { studioHostContract } from "../../shared/host-contract.ts";

const instructions = instructionFiles(import.meta.url);
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
  private file(game: Game, path: string) {
    return { hostId: game.hostId, rootPath: game.rootPath, path: projectFile(game.rootPath, path) };
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
  async start(game: Game, job: GenerationJob) {
    return this.serial(game, job.id, async () => {
      if (job.request.kind !== "text") throw new Error("A text request is required.");
      const providers = await this.bb.sdk.providers.list();
      const providerId = job.request.providerId;
      if (providerId && !providers.some((provider) => provider.id === providerId))
        throw new Error("The selected BB provider is unavailable.");
      const projects = await this.bb.sdk.projects.list({ includePersonal: true });
      const personal = projects.find((project) => project.kind === "personal");
      if (!personal) throw new Error("BB's personal workspace is unavailable for text generation.");
      const images = await Promise.all(
        job.request.images.map(async (path) => {
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
      const { revision } = await this.read(game, job.id);
      try {
        const task = await this.bb.sdk.threads.spawn({
          projectId: personal.id,
          environment: { type: "host", hostId: game.hostId, workspace: { type: "personal" } },
          providerId: job.request.providerId,
          model: job.request.model.id,
          visibility: "hidden",
          origin: "plugin",
          originPluginId: "game-studio",
          title: `Canvas text · ${job.id}`,
          pluginMetadata: { gameStudioJobId: job.id, gameStudioGameId: game.id },
          input: [
            {
              type: "text",
              mentions: [],
              text: `${instructions.read("canvas-text")}\n\n${job.request.prompt}`,
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
  async status(game: Game, id: string, cancel = false) {
    return this.serial(game, id, async () => {
      const { job, revision } = await this.read(game, id);
      if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
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
            const path = `canvas/staging/${job.id}/output.md`;
            const written = await this.bb.sdk.files.write({
              ...this.file(game, path),
              content: text,
              contentEncoding: "utf8",
              expectedSha256: null,
              createParents: true,
            });
            if (written.outcome === "conflict") {
              const existing = await this.bb.sdk.files.read(this.file(game, path));
              if (existing.content !== text)
                throw new Error("The staged text was edited. Its newer content was preserved.");
            }
            job.outputs = [
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
      await this.save(game, job, cancel ? (await this.read(game, id)).revision : revision);
      return job;
    });
  }
}
