import { GenerationWork } from "./generation-work.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { studioHostContract } from "../../shared/host-contract.ts";
import {
  mediaRequest,
  normalizeMediaRequest,
  providerCapabilities,
  type MediaRequest,
  type GenerationJob,
  type canvasGenerationInput,
  type generationControlInput,
  type canvasDirectInput,
  type canvasDirectControl,
} from "../../shared/generation.ts";
import { getGame, loadWorkspace, adoptGeneration } from "./studio.ts";
import type { SlotStore } from "./slot-store.ts";
import { canvasRequest } from "./canvas-generation.ts";
import { captureCanvasInputs } from "./generation-inputs.ts";
import { CanvasText } from "./canvas-text.ts";

type Credentials = { vertexProject?: string; falAccessToken?: string };
type Game = Awaited<ReturnType<typeof getGame>>;
type AdoptionResult = {
  job: GenerationJob;
  adoption: Awaited<ReturnType<typeof adoptGeneration>> | { deferred: true; reason: string };
};
export type GenerationContext = { bb: BbPluginApi; generations: Generations };

export class Generations {
  private readonly bb: BbPluginApi;
  private readonly settings: (provider: MediaRequest["model"]["provider"]) => Promise<Credentials>;
  private readonly slots: SlotStore;
  private readonly work: GenerationWork;
  private readonly text: CanvasText;
  private readonly adoptions = new Map<string, Promise<AdoptionResult>>();
  private readonly jobOperations = new Map<string, Promise<unknown>>();
  constructor(
    bb: BbPluginApi,
    settings: (provider: MediaRequest["model"]["provider"]) => Promise<Credentials>,
    slots: SlotStore,
  ) {
    this.bb = bb;
    this.settings = settings;
    this.slots = slots;
    this.work = new GenerationWork(slots);
    this.text = new CanvasText(bb);
  }
  private async credentials(provider: MediaRequest["model"]["provider"]): Promise<Credentials> {
    const settings = await this.settings(provider);
    return {
      ...(settings.vertexProject ? { vertexProject: settings.vertexProject } : {}),
      ...(settings.falAccessToken ? { falAccessToken: settings.falAccessToken } : {}),
    };
  }
  private async game(gameId: string, threadId: string | undefined, writable = true) {
    if (!threadId) throw new Error("Generation requires a BB thread.");
    const game = await getGame(this.bb, gameId);
    const thread = await this.bb.sdk.threads.get({ threadId });
    if (thread.projectId !== game.projectId || !thread.environmentId)
      throw new Error("Use a thread in the game's BB project and checkout.");
    const environment = await this.bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.hostId !== game.hostId || !environment.path)
      throw new Error("Use a thread on the game's host and checkout.");
    const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
    const [actual, expected] = await Promise.all(
      [environment.path, game.rootPath].map((path) =>
        client.call("resolveWorkspace", { path }, { hostId: game.hostId }),
      ),
    );
    if (
      !actual?.workspacePath ||
      !expected?.workspacePath ||
      actual.workspacePath !== expected.workspacePath
    )
      throw new Error("This thread is attached to another checkout.");
    if (writable) this.slots.editorAccess(game.hostId, expected.workspacePath, threadId);
    else {
      const slot = this.slots.find(game.hostId, expected.workspacePath);
      if (slot && slot.ownerThreadId !== threadId)
        throw new Error("Only the checkout owner can reconcile generation jobs.");
    }
    return { ...game, rootPath: expected.workspacePath };
  }
  async list(gameId: string) {
    let game = await getGame(this.bb, gameId);
    const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
    const resolved = await client.call(
      "resolveWorkspace",
      { path: game.rootPath },
      { hostId: game.hostId },
    );
    if (!resolved?.workspacePath) throw new Error("The project's checkout is unavailable.");
    game = { ...game, rootPath: resolved.workspacePath };
    const jobs = await client.call("list", { rootPath: game.rootPath }, { hostId: game.hostId });
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index]!;
      if (job.origin.kind === "canvas" && job.origin.gameId === gameId)
        jobs[index] = await this.refreshCanvasJob(game, job);
    }
    return jobs;
  }
  private async refreshCanvasJob(game: Game, job: GenerationJob) {
    const key = this.jobKey(game, job.id);
    if (this.jobOperations.has(key)) return job;
    const owner = await this.serialJob(key, async () => {
      if (job.request.kind === "text") {
        const slot = this.slots.find(game.hostId, game.rootPath);
        if (slot && (slot.state !== "leased" || slot.ownerThreadId !== job.threadId)) return null;
        try {
          job = await this.text.status(game, job.id);
        } catch {
          job = {
            ...job,
            status: "uncertain" as const,
            detail: "Could not refresh this BB text run. Check its status before retrying.",
          };
          return null;
        }
      } else if (
        this.work.owner(game.hostId, game.rootPath, job.id) &&
        !["queued", "running"].includes(job.status)
      ) {
        // The list response may predate a queued retry or resume.
        const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
        job = await client.call(
          "status",
          { rootPath: game.rootPath, jobId: job.id },
          { hostId: game.hostId },
        );
      }
      const owner = this.work.owner(game.hostId, game.rootPath, job.id);
      if (owner && !["queued", "running"].includes(job.status)) {
        if (job.status === "succeeded") return owner;
        else this.work.settled(game.hostId, game.rootPath, job.id);
      }
      return null;
    });
    if (owner) await this.adopt(game, job, owner);
    return job;
  }
  private async canvasGame(gameId: string, threadId: string | null, writable = true) {
    if (threadId) return this.game(gameId, threadId, writable);
    const game = await getGame(this.bb, gameId);
    const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
    const resolved = await client.call(
      "resolveWorkspace",
      { path: game.rootPath },
      { hostId: game.hostId },
    );
    if (!resolved?.workspacePath) throw new Error("The project's checkout is unavailable.");
    // Unregistered projects need no agent thread. Registered slots require their real owner.
    this.slots.editorAccess(game.hostId, resolved.workspacePath, `canvas:${game.id}`);
    return { ...game, rootPath: resolved.workspacePath };
  }
  async direct(input: z.output<typeof canvasDirectInput>) {
    const game = await this.canvasGame(input.gameId, input.threadId);
    const workspace = await loadWorkspace(this.bb, input.gameId);
    const prepared = canvasRequest(workspace, input);
    if (!["image", "text"].includes(prepared.request.kind))
      throw new Error("Direct canvas generation supports image and text nodes.");
    return this.dispatch(game, input.requestId, prepared.request, input.threadId, prepared.target, {
      kind: "canvas",
      gameId: game.id,
    });
  }
  async directControl(input: z.output<typeof canvasDirectControl>) {
    const game = await this.canvasGame(input.gameId, input.threadId, input.action === "resume");
    const owner = input.threadId ?? `canvas:${game.id}`;
    const before = await this.readJob(game, input.jobId, owner);
    if (!before)
      return {
        job: null,
        detail: "No submission was made. The request ID is retired; you can generate again.",
      };
    if (before.origin.kind !== "canvas" || before.origin.gameId !== input.gameId)
      throw new Error("This job was not started from this canvas.");
    if (input.action !== "status" && before.threadId !== input.threadId)
      throw new Error("Only the requester can resume or stop this job.");
    return this.runControl(game, before, input.action, owner);
  }
  async context(gameId: string, threadId?: string) {
    await this.game(gameId, threadId);
    const workspace = await loadWorkspace(this.bb, gameId);
    return {
      game: workspace.game,
      mainDocument:
        workspace.documents.find((doc) => doc.id === workspace.index.mainDocumentId) ?? null,
      boards: workspace.boards.map(({ board, revision }) => ({
        id: board.id,
        name: board.name,
        revision,
        nodes: board.nodes.map(
          ({ position: _position, width: _width, height: _height, ...node }) => node,
        ),
        edges: board.edges,
      })),
      documents: workspace.documents.map(({ markdown: _markdown, ...doc }) => doc),
      assets: workspace.assets,
      providers: providerCapabilities,
    };
  }
  async start(
    gameId: string,
    requestId: string,
    request: MediaRequest,
    threadId?: string,
    target?: GenerationJob["target"],
  ) {
    const game = await this.game(gameId, threadId);
    return this.dispatch(game, requestId, request, threadId!, target, { kind: "agent" });
  }
  private async dispatch(
    game: Game,
    requestId: string,
    request: MediaRequest,
    threadId: string | null,
    target: GenerationJob["target"] | undefined,
    origin: GenerationJob["origin"],
  ) {
    return this.serialJob(this.jobKey(game, requestId), async () => {
      const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
      let normalized = mediaRequest.parse(
        JSON.parse(JSON.stringify(normalizeMediaRequest(request))),
      );
      const credentials =
        normalized.kind === "text" ? {} : await this.credentials(normalized.model.provider);
      const reserved = this.work.reserve(
        game.hostId,
        game.rootPath,
        requestId,
        threadId ?? `canvas:${game.id}`,
      );
      if (target) {
        try {
          const captured = await captureCanvasInputs(this.bb, game, {
            request: normalized,
            target,
          });
          normalized = captured.request;
          target = captured.target;
        } catch (error) {
          if (reserved) this.work.settled(game.hostId, game.rootPath, requestId);
          throw error;
        }
      }
      if (normalized.kind === "text") {
        const result = await this.text.start(game, {
          version: 1,
          id: requestId,
          threadId,
          origin,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: "queued",
          request: normalized,
          target,
          outputs: [],
        });
        if (!["queued", "running"].includes(result.job.status))
          this.work.settled(game.hostId, game.rootPath, requestId);
        return result;
      }
      const result = await client.call(
        "start",
        {
          rootPath: game.rootPath,
          jobId: requestId,
          threadId,
          origin,
          request: normalized,
          credentials,
          ...(target ? { target } : {}),
        },
        { hostId: game.hostId },
      );
      if (
        !["queued", "running"].includes(result.job.status) &&
        !this.adoptions.has(this.jobKey(game, requestId))
      )
        this.work.settled(game.hostId, game.rootPath, requestId);
      return result;
    });
  }
  private async serialJob<T>(key: string, action: () => Promise<T>) {
    const next = (this.jobOperations.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(action);
    this.jobOperations.set(key, next);
    try {
      return await next;
    } finally {
      if (this.jobOperations.get(key) === next) this.jobOperations.delete(key);
    }
  }
  async canvas(input: z.output<typeof canvasGenerationInput>, threadId?: string) {
    await this.game(input.gameId, threadId);
    const workspace = await loadWorkspace(this.bb, input.gameId);
    const { request, target } = canvasRequest(workspace, input);
    return this.start(input.gameId, input.requestId, request, threadId, target);
  }
  async control(input: z.output<typeof generationControlInput>, threadId?: string) {
    const game = await this.game(input.gameId, threadId, input.action === "resume");
    const before = await this.readJob(game, input.jobId, threadId!);
    if (!before)
      return {
        job: null,
        status: "not-submitted",
        detail:
          "No job was created. This request ID is retired, and its checkout reservation is released. Use a new request ID for an authorized generation.",
      };
    if (input.action !== "status" && before.threadId !== threadId)
      throw new Error("Only the requesting thread can resume or stop this job.");
    return this.runControl(game, before, input.action, threadId!);
  }
  private async readJob(game: Game, jobId: string, threadId: string) {
    const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
    const target = { rootPath: game.rootPath, jobId };
    try {
      return await client.call("status", target, { hostId: game.hostId });
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT|no such file or directory/i.test(error.message))
        throw error;
      return this.serialJob(this.jobKey(game, jobId), async () => {
        const owner = this.work.owner(game.hostId, game.rootPath, jobId);
        if (owner && owner !== threadId)
          throw new Error("Only the requesting thread can reconcile this missing job.", {
            cause: error,
          });
        const result = await client.call("reconcileMissing", target, { hostId: game.hostId });
        if (result.missing) {
          this.work.settled(game.hostId, game.rootPath, jobId);
          return null;
        }
        return client.call("status", target, { hostId: game.hostId });
      });
    }
  }
  private async runControl(
    game: Game,
    before: GenerationJob,
    action: "status" | "resume" | "cancel",
    threadId: string,
  ) {
    if (before.status === "succeeded" && action === "status")
      return this.adopt(game, before, threadId);
    const job = await this.serialJob(this.jobKey(game, before.id), async () => {
      if (before.request.kind === "text")
        this.slots.editorAccess(game.hostId, game.rootPath, threadId);
      if (action === "resume") this.work.reserve(game.hostId, game.rootPath, before.id, threadId);
      const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
      const target = { rootPath: game.rootPath, jobId: before.id };
      let job = before;
      if (before.request.kind === "text")
        job = await this.text.status(game, before.id, action === "cancel");
      else if (action === "resume")
        job = await client.call(
          "resume",
          { ...target, credentials: await this.credentials(before.request.model.provider) },
          { hostId: game.hostId },
        );
      else if (action === "cancel")
        job = await client.call("cancel", target, { hostId: game.hostId });
      else job = await client.call("status", target, { hostId: game.hostId });
      if (!["queued", "running", "succeeded"].includes(job.status))
        this.work.settled(game.hostId, game.rootPath, job.id);
      return job;
    });
    if (job.status === "succeeded") return this.adopt(game, job, threadId);
    return { job };
  }
  private jobKey(game: Game, jobId: string) {
    return JSON.stringify([game.hostId, game.rootPath, jobId]);
  }
  private async adopt(game: Game, job: GenerationJob, threadId: string): Promise<AdoptionResult> {
    const key = this.jobKey(game, job.id);
    const existing = this.adoptions.get(key);
    if (existing) return existing;
    const pending = this.serialJob(key, async (): Promise<AdoptionResult> => {
      const slot = this.slots.find(game.hostId, game.rootPath);
      if (slot && (slot.state !== "leased" || slot.ownerThreadId !== threadId)) {
        this.work.settled(game.hostId, game.rootPath, job.id);
        return {
          job,
          adoption: {
            deferred: true,
            reason: "Restore the checkout lease before adopting staged outputs.",
          },
        };
      }
      // Keep release fenced for the entire adoption, including a repeated status call.
      const owner = this.work.owner(game.hostId, game.rootPath, job.id) ?? threadId;
      this.work.reserve(game.hostId, game.rootPath, job.id, owner);
      try {
        return { job, adoption: await adoptGeneration(this.bb, game, job) };
      } finally {
        this.work.settled(game.hostId, game.rootPath, job.id);
      }
    });
    this.adoptions.set(key, pending);
    try {
      return await pending;
    } finally {
      this.adoptions.delete(key);
    }
  }
}
