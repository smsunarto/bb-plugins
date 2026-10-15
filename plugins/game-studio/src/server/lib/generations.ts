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
} from "../../shared/generation.ts";
import { getGame, loadWorkspace, adoptGeneration } from "./studio.ts";
import type { SlotStore } from "./slot-store.ts";
import { canvasRequest } from "./canvas-generation.ts";

type Credentials = { googleApiKey?: string; falAccessToken?: string };
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
  private readonly adoptions = new Map<string, Promise<AdoptionResult>>();
  constructor(
    bb: BbPluginApi,
    settings: (provider: MediaRequest["model"]["provider"]) => Promise<Credentials>,
    slots: SlotStore,
  ) {
    this.bb = bb;
    this.settings = settings;
    this.slots = slots;
    this.work = new GenerationWork(slots);
  }
  private async credentials(provider: MediaRequest["model"]["provider"]): Promise<Credentials> {
    const settings = await this.settings(provider);
    return {
      ...(settings.googleApiKey ? { googleApiKey: settings.googleApiKey } : {}),
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
    const game = await getGame(this.bb, gameId);
    const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
    return client.call("list", { rootPath: game.rootPath }, { hostId: game.hostId });
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
    const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
    const normalized = mediaRequest.parse(
        JSON.parse(JSON.stringify(normalizeMediaRequest(request))),
      ),
      credentials = await this.credentials(normalized.model.provider);
    this.work.reserve(game.hostId, game.rootPath, requestId, threadId!);
    const result = await client.call(
      "start",
      {
        rootPath: game.rootPath,
        jobId: requestId,
        threadId: threadId!,
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
  }
  async canvas(input: z.output<typeof canvasGenerationInput>, threadId?: string) {
    await this.game(input.gameId, threadId);
    const workspace = await loadWorkspace(this.bb, input.gameId);
    const { request, target } = canvasRequest(workspace, input);
    return this.start(input.gameId, input.requestId, request, threadId, target);
  }
  async control(input: z.output<typeof generationControlInput>, threadId?: string) {
    const game = await this.game(input.gameId, threadId, input.action === "resume");
    const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
    const target = { rootPath: game.rootPath, jobId: input.jobId };
    let before;
    try {
      before = await client.call("status", target, { hostId: game.hostId });
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT|no such file or directory/i.test(error.message))
        throw error;
      const owner = this.work.owner(game.hostId, game.rootPath, input.jobId);
      if (owner && owner !== threadId)
        throw new Error("Only the requesting thread can reconcile this missing job.");
      const result = await client.call("reconcileMissing", target, { hostId: game.hostId });
      if (result.missing) {
        this.work.settled(game.hostId, game.rootPath, input.jobId);
        return {
          job: null,
          status: "not-submitted",
          detail:
            "No job was created. This request ID is retired, and its checkout reservation is released. Use a new request ID for an authorized generation.",
        };
      }
      before = await client.call("status", target, { hostId: game.hostId });
    }
    if (input.action !== "status" && before.threadId !== threadId)
      throw new Error("Only the requesting thread can resume or stop this job.");
    if (input.action === "resume")
      this.work.reserve(game.hostId, game.rootPath, input.jobId, threadId!);
    const job =
      input.action === "resume"
        ? await client.call(
            "resume",
            { ...target, credentials: await this.credentials(before.request.model.provider) },
            { hostId: game.hostId },
          )
        : input.action === "cancel"
          ? await client.call("cancel", target, { hostId: game.hostId })
          : before;
    if (job.status === "succeeded") return this.adopt(game, job, threadId!);
    if (!["queued", "running"].includes(job.status))
      this.work.settled(game.hostId, game.rootPath, input.jobId);
    return { job };
  }
  private jobKey(game: Game, jobId: string) {
    return JSON.stringify([game.hostId, game.rootPath, jobId]);
  }
  private async adopt(game: Game, job: GenerationJob, threadId: string): Promise<AdoptionResult> {
    const key = this.jobKey(game, job.id);
    const existing = this.adoptions.get(key);
    if (existing) return existing;
    const pending = (async (): Promise<AdoptionResult> => {
      const slot = this.slots.find(game.hostId, game.rootPath);
      if (slot && slot.state !== "leased") {
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
    })();
    this.adoptions.set(key, pending);
    try {
      return await pending;
    } finally {
      this.adoptions.delete(key);
    }
  }
}
