import { GenerationWork } from "./generation-work.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { studioHostContract } from "../../shared/host-contract.ts";
import {
  mediaRequest,
  normalizeMediaRequest,
  providerCapabilities,
  runsOnBb,
  type MediaRequest,
  type GenerationJob,
  type canvasGenerationInput,
  type generationControlInput,
  type canvasDirectInput,
  type canvasDirectControl,
} from "../../shared/generation.ts";
import { getGame, loadCanvas, loadWorkspace, adoptGeneration } from "./studio.ts";
import type { SlotStore } from "./slot-store.ts";
import { canvasRequest, judgeRequest, retryRequest, reviewRequest } from "./canvas-generation.ts";
import {
  judgeRequestId,
  manualCandidates,
  nodeJudgeSettings,
  runCandidates,
} from "../../shared/judge.ts";
import { nodeTakes, takeRun } from "../../shared/takes.ts";
import { nodeReviewSettings, reviewRequestId } from "../../shared/review.ts";
import { captureCanvasInputs } from "./generation-inputs.ts";
import { CanvasText } from "./canvas-text.ts";

type Credentials = { vertexProject?: string; falAccessToken?: string };
type Game = Awaited<ReturnType<typeof getGame>>;
type AdoptionResult = {
  job: GenerationJob;
  adoption: Awaited<ReturnType<typeof adoptGeneration>> | { deferred: true; reason: string };
};
export type GenerationContext = { bb: BbPluginApi; generations: Generations };

/** A board's node, or an error naming what is gone. */
function nodeOf(
  workspace: Awaited<ReturnType<typeof loadWorkspace>>,
  boardId: string,
  nodeId: string,
) {
  const node = workspace.boards
    .find(({ board }) => board.id === boardId)
    ?.board.nodes.find(({ id }) => id === nodeId);
  if (!node) throw new Error("The canvas node no longer exists.");
  return node;
}

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
  /** Every job in the game's checkout, with canvas runs refreshed and finished outputs adopted. */
  async list(gameId: string) {
    const read = await loadCanvas(this.bb, gameId);
    return (await this.refresh(read.workspace.game, read)).jobs;
  }
  /**
   * Refreshes the canvas jobs a workspace read listed: a BB run's status, and
   * the adoption of finished outputs. `changed` says the refresh moved a job
   * or wrote to the canvas, which a later read shows.
   */
  async refresh(
    game: Game,
    read: { workspacePath: string | null; workspace: { generationJobs: GenerationJob[] } },
  ) {
    if (!read.workspacePath) throw new Error("The project's checkout is unavailable.");
    const resolved = { ...game, rootPath: read.workspacePath };
    const jobs = [...read.workspace.generationJobs];
    let changed = false;
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index]!;
      if (job.origin.kind !== "canvas" || job.origin.gameId !== game.id) continue;
      const refreshed = await this.refreshCanvasJob(resolved, job);
      if (refreshed.adopted || JSON.stringify(refreshed.job) !== JSON.stringify(job))
        changed = true;
      jobs[index] = refreshed.job;
    }
    return { jobs, changed };
  }
  private async refreshCanvasJob(game: Game, job: GenerationJob) {
    const key = this.jobKey(game, job.id);
    if (this.jobOperations.has(key)) return { job, adopted: false };
    const owner = await this.serialJob(key, async () => {
      if (runsOnBb(job.request)) {
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
    return { job, adopted: Boolean(owner) };
  }
  /**
   * Canvas runs belong to the canvas, whichever thread sits beside it. The open thread only
   * matters when it holds the lease on a registered checkout, which only its owner may write.
   */
  private async canvasGame(gameId: string, threadId: string | null, writable = true) {
    const game = await getGame(this.bb, gameId);
    const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
    const resolved = await client.call(
      "resolveWorkspace",
      { path: game.rootPath },
      { hostId: game.hostId },
    );
    if (!resolved?.workspacePath) throw new Error("The project's checkout is unavailable.");
    const slot = this.slots.find(game.hostId, resolved.workspacePath);
    if (threadId && slot?.state === "leased" && slot.ownerThreadId === threadId)
      return { game: await this.game(gameId, threadId, writable), thread: threadId };
    this.slots.editorAccess(game.hostId, resolved.workspacePath, `canvas:${game.id}`);
    return { game: { ...game, rootPath: resolved.workspacePath }, thread: null };
  }
  async direct(input: z.output<typeof canvasDirectInput>) {
    const { game, thread } = await this.canvasGame(input.gameId, input.threadId);
    const workspace = await loadWorkspace(this.bb, input.gameId);
    const prepared = input.reviewAssetId
      ? reviewRequest(workspace, input.boardId, input.nodeId, [input.reviewAssetId])
      : input.judge
        ? judgeRequest(
            workspace,
            input.boardId,
            input.nodeId,
            manualCandidates(nodeOf(workspace, input.boardId, input.nodeId)),
          )
        : canvasRequest(workspace, input);
    if (!["image", "text", "agent", "model-edit"].includes(prepared.request.kind))
      throw new Error("Direct canvas generation supports image, text, agent and Tripo nodes.");
    return this.dispatch(game, input.requestId, prepared.request, thread, prepared.target, {
      kind: "canvas",
      gameId: game.id,
    });
  }
  async directControl(input: z.output<typeof canvasDirectControl>) {
    const { game, thread } = await this.canvasGame(
      input.gameId,
      input.threadId,
      input.action === "resume",
    );
    const owner = thread ?? `canvas:${game.id}`;
    const before = await this.readJob(game, input.jobId, owner);
    if (!before)
      return {
        job: null,
        detail: "No submission was made. The request ID is retired; you can generate again.",
      };
    if (before.origin.kind !== "canvas" || before.origin.gameId !== input.gameId)
      throw new Error("This job was not started from this canvas.");
    // Only a leased checkout has a requester to protect; other canvas jobs belong to the canvas.
    if (input.action !== "status" && thread && before.threadId !== thread)
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
      const credentials = runsOnBb(normalized)
        ? {}
        : await this.credentials(normalized.model.provider);
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
      if (runsOnBb(normalized)) {
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
      if (runsOnBb(before.request)) this.slots.editorAccess(game.hostId, game.rootPath, threadId);
      if (action === "resume") this.work.reserve(game.hostId, game.rootPath, before.id, threadId);
      const client = this.bb.hosts.experimental_client({ contract: studioHostContract });
      const target = { rootPath: game.rootPath, jobId: before.id };
      let job = before;
      if (runsOnBb(before.request))
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
  /** Starts the review of a finished run when its node reviews each output. */
  private async reviewRun(game: Game, job: GenerationJob, assetIds: string[]) {
    if (job.request.kind === "text" || !job.target || !assetIds.length) return;
    try {
      const workspace = await loadWorkspace(this.bb, game.id);
      const node = workspace.boards
        .find(({ board }) => board.id === job.target!.boardId)
        ?.board.nodes.find(({ id }) => id === job.target!.nodeId);
      if (!node || !nodeReviewSettings(node)?.enabled) return;
      const { request, target } = reviewRequest(
        workspace,
        job.target.boardId,
        job.target.nodeId,
        assetIds,
      );
      // The run's id names its review, so a repeated adoption finds the review it started.
      await this.dispatch(game, reviewRequestId(job.id), request, null, target, {
        kind: "canvas",
        gameId: game.id,
      });
    } catch (error) {
      // A failed review never undoes the outputs it would have judged.
      this.bb.log.warn(
        `Could not start the review of ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  /**
   * Starts the node's judge over a finished run's outputs and its current pick. A batch is one
   * run, so its last job to land starts the judge, once every output it made is on the node.
   */
  private async judgeRun(game: Game, job: GenerationJob) {
    if (job.request.kind === "text" || !job.target) return;
    try {
      const workspace = await loadWorkspace(this.bb, game.id);
      const node = nodeOf(workspace, job.target.boardId, job.target.nodeId);
      if (!nodeJudgeSettings(node)?.enabled) return;
      const run = takeRun(job.id);
      const takes = nodeTakes(node);
      const pending = workspace.generationJobs.some(
        (other) =>
          other.id !== job.id &&
          takeRun(other.id) === run &&
          (["queued", "running"].includes(other.status) ||
            (other.status === "succeeded" &&
              other.outputs.some(({ type }) => type !== "text") &&
              !takes.some((take) => take.jobId === other.id))),
      );
      const candidates = runCandidates(node, run);
      if (pending || candidates.length < 2) return;
      const { request, target } = judgeRequest(
        workspace,
        job.target.boardId,
        job.target.nodeId,
        candidates,
      );
      await this.dispatch(game, judgeRequestId(run), request, null, target, {
        kind: "canvas",
        gameId: game.id,
      });
    } catch (error) {
      // A failed judge leaves the pick as it was.
      this.bb.log.warn(
        `Could not start the judge of ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  /** Runs a generation again when its automatic review rejects it and the node allows a retry. */
  private async retryRun(game: Game, review: GenerationJob) {
    try {
      const retry = retryRequest(await loadWorkspace(this.bb, game.id), review);
      if (!retry) return;
      // Retries belong to the canvas, like the reviews that call for them.
      await this.dispatch(game, retry.requestId, retry.request, null, retry.target, {
        kind: "canvas",
        gameId: game.id,
      });
    } catch (error) {
      this.bb.log.warn(
        `Could not retry the run ${review.id} judged: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
        const adoption = await adoptGeneration(this.bb, game, job);
        if (adoption.attached && job.request.kind === "text") await this.retryRun(game, job);
        else if (adoption.attached) {
          await this.reviewRun(game, job, adoption.candidateAssetIds);
          await this.judgeRun(game, job);
        }
        return { job, adoption };
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
