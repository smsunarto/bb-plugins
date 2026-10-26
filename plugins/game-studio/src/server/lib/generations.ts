import { randomUUID } from "node:crypto";
import { GenerationWork } from "./generation-work.ts";
import type {
  BbPluginApi,
  PluginInteractionRequest,
  PluginInteractionResult,
} from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { studioHostContract } from "../../shared/host-contract.ts";
import {
  mediaRequest,
  nodeAgent,
  normalizeMediaRequest,
  runsOnBb,
  type CanvasRunResult,
  type MediaRequest,
  type GenerationJob,
  type canvasGenerationInput,
  type generationControlInput,
  type canvasDirectInput,
  type canvasDirectControl,
  type cancelCanvasRunInput,
} from "../../shared/generation.ts";
import { getGame, loadCanvas, loadWorkspace, adoptGeneration, saveBoard } from "./studio.ts";
import type { SlotStore } from "./slot-store.ts";
import { canvasRequest, judgeRequest, retryRequest, reviewRequest } from "./canvas-generation.ts";
import { judgeRequestId, nodeJudgeSettings, runCandidates } from "../../shared/judge.ts";
import { batchRequestId, nodeTakes, takeRun } from "../../shared/takes.ts";
import { inputsReady, planRun } from "../../shared/canvas-plan.ts";
import { nodeBatch, recipeModel } from "../../shared/recipes.ts";
import {
  APPROVAL_RENDERER,
  generationApprovalResponse,
  itemBudget,
  paidProvider,
  type GenerationApprovalItem,
  type GenerationApprovalPayload,
} from "../../shared/approvals.ts";
import { ApprovalStore, type ApprovedSpec } from "./canvas-approvals.ts";
import {
  CanvasRunStore,
  type HeldRun,
  type HeldRunAgent,
  type HeldRunOptions,
} from "./canvas-runs.ts";
import type {
  ApprovalGrant,
  Board,
  BoardEdit,
  CanvasNode,
  Workspace,
  undoCanvasEditInput,
} from "../../shared/schema.ts";
import { nodeReviewSettings, retryLineage, reviewRequestId } from "../../shared/review.ts";
import { captureCanvasInputs } from "./generation-inputs.ts";
import { CanvasText } from "./canvas-text.ts";
import { applyCanvasEdits, describeEdit, editCanvas, saveCanvasEdit } from "./canvas-edit.ts";
import { CanvasEditStore, restoredBoard, undoBlocker } from "./canvas-edits.ts";
import { readCanvasContext } from "./canvas-context.ts";
import { CanvasCollection } from "./canvas-collection.ts";
import { canvasContextInput, canvasEditInput } from "../../shared/canvas-agent.ts";

type Credentials = { vertexProject?: string; falAccessToken?: string };
type Game = Awaited<ReturnType<typeof getGame>>;
type RunInput = z.output<typeof canvasGenerationInput> & { threadId: string | null };
/** Asks the person in the thread; the SDK's form by default, a stub under test. */
type Ask = (request: PluginInteractionRequest) => Promise<PluginInteractionResult>;
/** How long a run waits for the person before the agent is told nobody answered. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
/** What an agent gets when the person declines: a plain result, so a new turn can ask what to change. */
const declined = () => ({
  declined: true as const,
  detail:
    "The person declined this generation. Nothing was submitted and nothing was spent. Ask what to change before trying again.",
});
const running = (job: GenerationJob) => job.status === "queued" || job.status === "running";
/** A text job that serves a media node (its brief, review, or judgement), not a node's own output. */
const auxiliary = (job: GenerationJob) =>
  job.request.kind === "text" &&
  !!(job.request.briefFor || job.request.reviewOf || job.request.judgeOf);
/** How often a game with held runs is read while no studio reads it, and the most it backs off to. */
const ADVANCE_EVERY_MS = 20_000;
const ADVANCE_MAX_MS = 10 * 60_000;
/** The request ids a run submits: one, or its batch. */
const batchIds = (run: Pick<HeldRun, "requestId" | "batch">) =>
  run.batch > 1
    ? Array.from({ length: run.batch }, (_, index) => batchRequestId(run.requestId, index))
    : [run.requestId];
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
  private readonly collection: CanvasCollection;
  private readonly runs: CanvasRunStore;
  private readonly approvals: ApprovalStore;
  private readonly editLog: CanvasEditStore;
  private readonly ask: Ask;
  /** Games whose agent runs the person approved in advance, until bb restarts or they stop it. */
  private readonly grants = new Map<string, ApprovalGrant>();
  private readonly adoptions = new Map<string, Promise<AdoptionResult>>();
  private readonly jobOperations = new Map<string, Promise<unknown>>();
  private readonly advances = new Map<string, Promise<void>>();
  /** Games whose landing signal arrived while a dispatch pass ran, so one more pass follows. */
  private readonly again = new Set<string>();
  /** One plan, dispatch, or cancel at a time per game, so two never read one workspace and start one input twice. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly drivers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delays = new Map<string, number>();
  private disposed = false;
  constructor(
    bb: BbPluginApi,
    settings: (provider: MediaRequest["model"]["provider"]) => Promise<Credentials>,
    slots: SlotStore,
    options: { ask?: Ask } = {},
  ) {
    this.bb = bb;
    this.settings = settings;
    this.slots = slots;
    this.work = new GenerationWork(slots);
    this.text = new CanvasText(bb);
    this.collection = new CanvasCollection(bb, slots, this.work);
    this.runs = new CanvasRunStore(slots.db);
    this.approvals = new ApprovalStore(slots.db);
    this.editLog = new CanvasEditStore(slots.db);
    this.ask = options.ask ?? ((request) => bb.ui.requestInput(request));
    // Runs held before a restart go on without a studio reading them.
    for (const gameId of this.runs.games()) this.drive(gameId, ADVANCE_EVERY_MS);
  }
  dispose() {
    this.disposed = true;
    for (const timer of this.drivers.values()) clearTimeout(timer);
    this.drivers.clear();
  }
  /** The held runs of a game by board and node, as a workspace read shows them. */
  pending(gameId: string) {
    return this.runs.pending(gameId);
  }
  /** Each board's agent edits as a workspace read shows them. */
  edits(workspace: Workspace): Record<string, BoardEdit[]> {
    return this.editLog.forWorkspace(workspace);
  }
  /** Whether a game's agent runs are approved in advance, and by whom. */
  grant(gameId: string): ApprovalGrant | null {
    return this.grants.get(gameId) ?? null;
  }
  setGrant(gameId: string, grant: ApprovalGrant | null) {
    if (grant) this.grants.set(gameId, grant);
    else this.grants.delete(gameId);
    return this.grant(gameId);
  }
  /**
   * Asks the person once for everything paid a run will make, unless the game is approved in
   * advance, and records a budget per request lineage that dispatches spend. Nothing paid
   * means nothing to ask. Inside a tool the form detaches the call: the agent hears the
   * answer, and the run's result, as a message.
   */
  private async approve(
    game: Game,
    threadId: string,
    items: GenerationApprovalItem[],
    boardId?: string,
  ): Promise<"approved" | "declined"> {
    const paid = items.filter((item) => paidProvider(item.provider));
    if (!paid.length) return "approved";
    if (!this.grants.has(game.id)) {
      const payload: GenerationApprovalPayload = {
        gameId: game.id,
        gameName: game.name,
        ...(boardId ? { boardId } : {}),
        items: paid,
      };
      const summary = paid
        .map(
          (item) =>
            `- ${item.title}: ${item.provider}${item.model ? ` ${item.model}` : ""}${item.count > 1 ? ` ×${item.count}` : ""}`,
        )
        .join("\n");
      const result = await this.ask({
        threadId,
        rendererId: APPROVAL_RENDERER,
        title: `Approve ${paid.length === 1 ? "a generation" : `${paid.length} generations`} for ${game.name}`,
        payload,
        timeoutMs: APPROVAL_TIMEOUT_MS,
        presentation: {
          label: { pending: "Waiting for generation approval", completed: "Generation approval" },
        },
        describeSubmission: (value) => {
          const answer = generationApprovalResponse.safeParse(value);
          return {
            title:
              answer.success && answer.data.approved
                ? "Approved generation"
                : "Declined generation",
            detail: summary,
          };
        },
      });
      const answer =
        result.outcome === "submitted" ? generationApprovalResponse.safeParse(result.value) : null;
      if (!answer?.success || !answer.data.approved) return "declined";
      if (answer.data.grantGame) this.grants.set(game.id, { threadId, at: Date.now() });
    }
    for (const item of paid)
      this.approvals.grant({
        gameId: game.id,
        root: item.requestId,
        threadId,
        boardId: boardId ?? null,
        nodeId: item.nodeId ?? null,
        budget: itemBudget(item),
        spec: { provider: item.provider, ...(item.model ? { model: item.model } : {}) },
      });
    return "approved";
  }
  /**
   * The run an agent asks for, planned from the saved board before anyone is asked: the
   * request ids its nodes will run under, so the approval binds to those lineages.
   */
  private async planForApproval(game: Game, input: RunInput) {
    const workspace = await loadWorkspace(this.bb, game.id);
    const selected = workspace.boards.find(({ board }) => board.id === input.boardId);
    if (!selected || selected.revision !== input.revision)
      throw new Error(
        "The board changed. Read canvas_context and review the current brief before generating.",
      );
    const plan = planRun(selected.board, input.nodeId);
    if (plan.issues.length) throw new Error(plan.issues.map(({ message }) => message).join(" "));
    const ids = new Map(
      plan.queue.map((id) => [id, id === input.nodeId ? input.requestId : randomUUID()]),
    );
    const items = plan.queue.map((id) =>
      nodeItem(
        selected.board.nodes.find((node) => node.id === id)!,
        ids.get(id)!,
        1,
      ),
    );
    return { ids, items };
  }
  private exclusive<T>(gameId: string, action: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(gameId) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.locks.set(gameId, next);
    return next.finally(() => {
      if (this.locks.get(gameId) === next) this.locks.delete(gameId);
    });
  }
  private async credentials(provider: MediaRequest["model"]["provider"]): Promise<Credentials> {
    const settings = await this.settings(provider);
    return {
      ...(settings.vertexProject ? { vertexProject: settings.vertexProject } : {}),
      ...(settings.falAccessToken ? { falAccessToken: settings.falAccessToken } : {}),
    };
  }
  private async game(
    gameId: string,
    threadId: string | undefined,
    access: "write" | "reconcile" | "read" = "write",
  ) {
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
    if (access === "write") this.slots.editorAccess(game.hostId, expected.workspacePath, threadId);
    else if (access === "reconcile") {
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
    this.collection.schedule(game.id);
    return {
      jobs,
      changed,
      pending: this.runs.pending(game.id),
      grant: this.grants.get(game.id) ?? null,
    };
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
      return {
        game: await this.game(gameId, threadId, writable ? "write" : "reconcile"),
        thread: threadId,
      };
    this.slots.editorAccess(game.hostId, resolved.workspacePath, `canvas:${game.id}`);
    return { game: { ...game, rootPath: resolved.workspacePath }, thread: null };
  }
  /** A run from the canvas: the node's missing inputs first when asked, then the node. */
  async direct(input: z.output<typeof canvasDirectInput>): Promise<CanvasRunResult> {
    const { game, thread } = await this.canvasGame(input.gameId, input.threadId);
    if (input.brief || input.reviewAssetId || input.judge || !input.upstream) {
      const workspace = await loadWorkspace(this.bb, input.gameId);
      const prepared = canvasRequest(workspace, input);
      const job = await this.dispatch(
        game,
        input.requestId,
        prepared.request,
        thread,
        prepared.target,
        { kind: "canvas", gameId: game.id },
      );
      return { jobs: [job.job], waiting: [] };
    }
    const result = await this.exclusive(game.id, async () =>
      this.runPlan(game, thread, await loadWorkspace(this.bb, input.gameId), input, true),
    );
    if (result.waiting.length) this.drive(game.id, ADVANCE_EVERY_MS);
    return result;
  }
  /**
   * Drops a run held for a node, when it is still the run the caller saw, and the inputs that
   * run was making and that still wait. Inputs already generating finish as takes. The game's
   * lock keeps a dispatch pass from starting the run under a cancellation that reported success.
   */
  async cancel(input: z.output<typeof cancelCanvasRunInput>) {
    const { game } = await this.canvasGame(input.gameId, input.threadId, false);
    return this.exclusive(game.id, async () => {
      const cancelled = this.runs.release(game.id, input.boardId, input.nodeId, input.requestId);
      if (cancelled) this.runs.releaseOrigin(game.id, input.requestId);
      return { cancelled };
    });
  }
  /**
   * Starts what the node needs: inputs without an output run now when their own inputs are
   * ready, else wait as held runs; the node itself runs once they have landed. An input a
   * person approves before use (a front view, a UV candidate) ends the run there.
   */
  private async runPlan(
    game: Game,
    thread: string | null,
    workspace: Workspace,
    input: RunInput,
    batched: boolean,
    /** The request ids the person approved per node; a node the plan adds since cannot run. */
    approved?: Map<string, string>,
  ): Promise<CanvasRunResult> {
    const selected = workspace.boards.find(({ board }) => board.id === input.boardId);
    if (!selected || selected.revision !== input.revision)
      throw new Error(
        "The board changed. Read canvas_context and review the current brief before generating.",
      );
    const board = selected.board;
    const plan = planRun(board, input.nodeId);
    if (plan.issues.length) throw new Error(plan.issues.map(({ message }) => message).join(" "));
    if (approved && plan.queue.some((id) => !approved.has(id)))
      throw new Error(
        "The board changed while waiting for approval. Read canvas_context and run again.",
      );
    const agent = runAgent(input);
    const jobs: GenerationJob[] = [];
    const waiting: string[] = [];
    for (const id of plan.queue) {
      const node = board.nodes.find((node) => node.id === id)!;
      const isTarget = id === input.nodeId;
      // An input already generating, or held for another run, is waited for, not started twice.
      if (
        !isTarget &&
        (this.runs.get(game.id, board.id, id) ||
          workspace.generationJobs.some(
            (job) =>
              job.target?.boardId === board.id &&
              job.target.nodeId === id &&
              running(job) &&
              !auxiliary(job),
          ))
      ) {
        waiting.push(id);
        continue;
      }
      const run = {
        gameId: game.id,
        boardId: board.id,
        nodeId: id,
        requestId: approved?.get(id) ?? (isTarget ? input.requestId : randomUUID()),
        threadId: thread,
        agent,
        options: heldOptions(
          isTarget ? runOptions(input) : null,
          approved ? approvedSpec(node) : null,
        ),
        origin: isTarget ? null : input.requestId,
        batch: isTarget && batched ? nodeBatch(node) : 1,
      };
      if (!inputsReady(board, node)) {
        this.runs.hold(run);
        waiting.push(id);
        continue;
      }
      jobs.push(...(await this.dispatchNode(game, thread, workspace, board, node, run)));
    }
    return { jobs, waiting, ...(plan.gate ? { gate: plan.gate } : {}) };
  }
  /**
   * Dispatches one node's run from the saved board, as a batch when its model makes several;
   * `only` names the batch requests still to submit after a partial submission.
   */
  private async dispatchNode(
    game: Game,
    thread: string | null,
    workspace: Workspace,
    board: Board,
    node: CanvasNode,
    run: Pick<HeldRun, "requestId" | "agent" | "options" | "batch">,
    only?: string[],
  ) {
    const revision = workspace.boards.find((entry) => entry.board.id === board.id)!.revision;
    const agent = nodeAgent(node) ?? run.agent ?? undefined;
    const prepared = canvasRequest(workspace, {
      gameId: game.id,
      requestId: run.requestId,
      boardId: board.id,
      nodeId: node.id,
      revision,
      ...run.options,
      ...(agent && runsOnBbNode(node)
        ? {
            textProviderId: agent.providerId,
            model: { provider: "bb", id: agent.model },
            ...(agent.reasoningLevel ? { reasoningLevel: agent.reasoningLevel } : {}),
            ...(agent.serviceTier ? { serviceTier: agent.serviceTier } : {}),
          }
        : {}),
    });
    const ids = only ?? batchIds(run);
    if (!this.approvals.consume(game.id, run.requestId, ids.length))
      throw new Error(
        "The approved budget for this run is spent. Ask for approval again with a new request id.",
      );
    const results = await Promise.all(
      ids.map((id) =>
        this.dispatch(game, id, prepared.request, thread, prepared.target, {
          kind: "canvas",
          gameId: game.id,
        }),
      ),
    );
    return results.map(({ job }) => job);
  }
  /**
   * Dispatches held runs whose inputs have landed. One at a time per game; a run whose job
   * already exists is released without building its request again, so a lost response or a
   * restart never submits a second generation under its id.
   */
  advance(gameId: string): Promise<void> {
    const previous = this.advances.get(gameId);
    if (previous) {
      // A landing that arrives mid-pass may postdate the pass's read: one more pass follows.
      this.again.add(gameId);
      return previous;
    }
    const pending = (async () => {
      do {
        this.again.delete(gameId);
        await this.exclusive(gameId, () => this.advanceNow(gameId));
      } while (this.again.has(gameId));
    })().finally(() => {
      if (this.advances.get(gameId) === pending) this.advances.delete(gameId);
    });
    this.advances.set(gameId, pending);
    return pending;
  }
  private async advanceNow(gameId: string) {
    const held = this.runs.list(gameId);
    if (!held.length) return;
    const workspace = await loadWorkspace(this.bb, gameId);
    const jobs = new Set(workspace.generationJobs.map((job) => job.id));
    for (const run of held) {
      const selected = workspace.boards.find(({ board }) => board.id === run.boardId);
      const node = selected?.board.nodes.find(({ id }) => id === run.nodeId);
      if (!selected || !node) {
        this.runs.release(gameId, run.boardId, run.nodeId, run.requestId);
        continue;
      }
      // A batch whose first requests reached the host before a crash finishes with the rest.
      const missing = batchIds(run).filter((id) => !jobs.has(id));
      if (!missing.length) {
        this.runs.release(gameId, run.boardId, run.nodeId, run.requestId);
        continue;
      }
      if (missing.length === run.batch && !inputsReady(selected.board, node)) continue;
      // The person approved a model; a node changed since waits for a new approval.
      if (run.options?.approved && !sameSpec(run.options.approved, node)) {
        this.runs.fail(
          gameId,
          run.boardId,
          run.nodeId,
          "The model changed after approval. Cancel this run and run the node again.",
        );
        continue;
      }
      try {
        const { game, thread } = await this.canvasGame(gameId, run.threadId);
        await this.dispatchNode(game, thread, workspace, selected.board, node, run, missing);
        this.runs.release(gameId, run.boardId, run.nodeId, run.requestId);
      } catch (error) {
        this.runs.fail(
          gameId,
          run.boardId,
          run.nodeId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
  /**
   * Keeps a game with held runs moving while no studio reads it: adopt, advance, repeat. A
   * sooner wake replaces a later one, so a new run is not left waiting out a backed-off delay.
   */
  private drive(gameId: string, delay: number) {
    if (this.disposed) return;
    const current = this.delays.get(gameId);
    if (this.drivers.has(gameId) && current !== undefined && current <= delay) return;
    clearTimeout(this.drivers.get(gameId));
    const timer = setTimeout(() => {
      this.drivers.delete(gameId);
      this.delays.delete(gameId);
      void this.tick(gameId, delay);
    }, delay);
    timer.unref?.();
    this.drivers.set(gameId, timer);
    this.delays.set(gameId, delay);
  }
  private async tick(gameId: string, delay: number) {
    if (this.disposed || !this.runs.list(gameId).length) return;
    let failed = false;
    try {
      const read = await loadCanvas(this.bb, gameId);
      await this.refresh(read.workspace.game, read);
      await this.advance(gameId);
    } catch (error) {
      failed = true;
      this.bb.log.warn(
        `Could not advance held canvas runs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const held = this.runs.list(gameId);
    if (!held.length) return;
    // Runs that keep failing, or a checkout that cannot be read, are tried less and less often
    // until a new run or a cancel changes things; a person sees the error on the card meanwhile.
    const stuck = failed || held.every((run) => run.error);
    this.drive(gameId, stuck ? Math.min(delay * 2, ADVANCE_MAX_MS) : ADVANCE_EVERY_MS);
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
  async context(input: z.output<typeof canvasContextInput>, threadId?: string) {
    await this.game(input.gameId, threadId, "read");
    return readCanvasContext(this.bb, input, this.runs.pending(input.gameId));
  }
  /**
   * An agent's edit, and the run it asks for on the edited board. The run is planned from the
   * edit before it is saved, so the person approves what the agent proposes and a decline
   * saves nothing; the save and the dispatch then share one turn of the game's lock.
   */
  async editCanvas(input: z.output<typeof canvasEditInput>, threadId?: string) {
    const game = await this.game(input.gameId, threadId);
    const log = { edits: this.editLog, threadId: threadId ?? null };
    const run = input.run;
    if (!run) return editCanvas(this.bb, input, log);
    const workspace = await loadWorkspace(this.bb, input.gameId);
    const board = applyCanvasEdits(workspace, input);
    const plan = planRun(board, run.nodeId);
    if (plan.issues.length) throw new Error(plan.issues.map(({ message }) => message).join(" "));
    if (input.dryRun)
      return {
        ...describeEdit(input, board, null),
        run: { planned: plan.queue, ...(plan.gate ? { gate: plan.gate } : {}) },
      };
    const ids = new Map(
      plan.queue.map((id) => [id, id === run.nodeId ? run.requestId : randomUUID()]),
    );
    const items = plan.queue.map((id) =>
      nodeItem(
        board.nodes.find((node) => node.id === id)!,
        ids.get(id)!,
        1,
      ),
    );
    const verdict = await this.approve(game, threadId!, items, board.id);
    if (verdict !== "approved") return { ...describeEdit(input, board, null), ...declined() };
    const result = await this.exclusive(game.id, async () => {
      const saved = await saveCanvasEdit(this.bb, workspace, board, input, log);
      const started = await this.runPlan(
        game,
        threadId!,
        await loadWorkspace(this.bb, input.gameId),
        {
          gameId: input.gameId,
          boardId: input.boardId,
          nodeId: run.nodeId,
          requestId: run.requestId,
          revision: saved.revision,
          upstream: true,
          threadId: threadId!,
        },
        false,
        ids,
      );
      return { ...describeEdit(input, board, saved), run: started };
    });
    if (result.run.waiting.length) this.drive(game.id, ADVANCE_EVERY_MS);
    return result;
  }
  /** Puts back what an agent's edit changed, as the studio asks, while it is still the latest. */
  async undoEdit(input: z.output<typeof undoCanvasEditInput>) {
    const { game } = await this.canvasGame(input.gameId, input.threadId);
    return this.exclusive(game.id, async () => {
      const workspace = await loadWorkspace(this.bb, input.gameId);
      const current = workspace.boards.find(({ board }) => board.id === input.boardId);
      if (!current) throw new Error("This board no longer exists.");
      const edit = this.editLog.get(game.id, input.editId);
      if (!edit || edit.boardId !== input.boardId)
        throw new Error("This edit is no longer on record.");
      const blocker = undoBlocker(edit, current, workspace.assets);
      if (blocker) throw new Error(blocker);
      const restored = restoredBoard(current.board, edit.before);
      const saved = await saveBoard(this.bb, {
        gameId: input.gameId,
        board: restored,
        revision: current.revision,
      });
      this.editLog.record({
        gameId: game.id,
        boardId: input.boardId,
        threadId: input.threadId,
        undoOf: edit.id,
        before: current.board,
        after: restored,
        beforeRevision: current.revision,
        afterRevision: saved.revision,
      });
      return { revision: saved.revision };
    });
  }
  async start(
    gameId: string,
    requestId: string,
    request: MediaRequest,
    threadId?: string,
    target?: GenerationJob["target"],
  ) {
    const game = await this.game(gameId, threadId);
    const verdict = await this.approve(game, threadId!, [requestItem(request, requestId, target)]);
    if (verdict !== "approved") return declined();
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
    const game = await this.game(input.gameId, threadId);
    const run: RunInput = { ...input, threadId: threadId! };
    if (input.upstream && !input.brief && !input.reviewAssetId && !input.judge) {
      // Plan, ask with no lock held, then plan again under the lock against the same ids.
      const planned = await this.planForApproval(game, run);
      const verdict = await this.approve(game, threadId!, planned.items, input.boardId);
      if (verdict !== "approved") return declined();
      const result = await this.exclusive(game.id, async () =>
        this.runPlan(
          game,
          threadId!,
          await loadWorkspace(this.bb, input.gameId),
          run,
          false,
          planned.ids,
        ),
      );
      if (result.waiting.length) this.drive(game.id, ADVANCE_EVERY_MS);
      return result;
    }
    const workspace = await loadWorkspace(this.bb, input.gameId);
    const { request, target } = canvasRequest(workspace, input);
    const node = nodeOf(workspace, input.boardId, input.nodeId);
    const verdict = await this.approve(
      game,
      threadId!,
      [requestItem(request, input.requestId, target, node.title)],
      input.boardId,
    );
    if (verdict !== "approved") return declined();
    return this.dispatch(game, input.requestId, request, threadId!, target, { kind: "agent" });
  }
  async control(input: z.output<typeof generationControlInput>, threadId?: string) {
    const game = await this.game(
      input.gameId,
      threadId,
      input.action === "resume" ? "write" : "reconcile",
    );
    const held = this.runs.byRequest(game.id, input.jobId);
    if (held) return this.heldControl(game, held, input.action, threadId!);
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
  /** A run the server still holds has no job: its status is that it waits, and it can be dropped. */
  private async heldControl(
    game: Game,
    held: HeldRun,
    action: "status" | "resume" | "cancel",
    threadId: string,
  ) {
    const run = {
      boardId: held.boardId,
      nodeId: held.nodeId,
      requestedAt: held.requestedAt,
      ...(held.error ? { error: held.error } : {}),
    };
    if (action === "resume")
      throw new Error("This run waits for its inputs; there is no job to resume yet.");
    if (action === "cancel") {
      if (held.threadId !== threadId)
        throw new Error("Only the requesting thread can stop this waiting run.");
      const { cancelled } = await this.cancel({
        gameId: game.id,
        boardId: held.boardId,
        nodeId: held.nodeId,
        requestId: held.requestId,
        threadId,
      });
      return { job: null, status: cancelled ? "cancelled" : "waiting", run };
    }
    return {
      job: null,
      status: "waiting",
      run,
      detail: held.error
        ? "The run could not start last time and is tried again when its inputs change. Fix the cause or cancel it."
        : "The run waits for its inputs to land; its job is created when they do. Check again later, or cancel it.",
    };
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
        if (result.pruned) {
          this.work.settled(game.hostId, game.rootPath, jobId);
          throw new Error(
            "This generation finished earlier, and Game Studio freed the outputs no canvas used. Its request ID stays retired; nothing was resubmitted. Do not submit it again.",
            { cause: error },
          );
        }
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
      // A retry spends the budget the person approved for the run it repeats.
      if (!this.approvals.consume(game.id, retryLineage(retry.requestId).root, 1)) {
        this.bb.log.warn(`Not retrying ${review.id}: its approved budget is spent.`);
        return;
      }
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
        // Takes of older runs just left the node; free their files.
        if (adoption.attached) this.collection.schedule(game.id, { soon: true });
        if (adoption.attached && job.request.kind === "text") await this.retryRun(game, job);
        else if (adoption.attached) {
          await this.reviewRun(game, job, adoption.candidateAssetIds);
          await this.judgeRun(game, job);
        }
        // A landed output may be what a held run was waiting for.
        if (adoption.attached) await this.advance(game.id);
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

/** The BB agent a run names for its text and agent steps, as the canvas composer selected it. */
function runAgent(input: RunInput): HeldRunAgent | null {
  if (!input.textProviderId || input.model?.provider !== "bb" || !input.model.id) return null;
  return {
    providerId: input.textProviderId,
    model: input.model.id,
    ...(input.reasoningLevel ? { reasoningLevel: input.reasoningLevel } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  };
}
/** The model a node runs on now, as an approval records it. */
function approvedSpec(node: CanvasNode): ApprovedSpec {
  const model = runsOnBbNode(node) ? undefined : recipeModel(node);
  return { provider: model?.provider ?? "bb", ...(model?.id ? { model: model.id } : {}) };
}
const sameSpec = (approved: ApprovedSpec, node: CanvasNode) => {
  const now = approvedSpec(node);
  return now.provider === approved.provider && (now.model ?? null) === (approved.model ?? null);
};
const heldOptions = (
  options: HeldRunOptions | null,
  approved: ApprovedSpec | null,
): HeldRunOptions | null =>
  options || approved ? { ...options, ...(approved ? { approved } : {}) } : null;
/** What a run makes, for the person to approve: one node on its recipe's model. */
function nodeItem(node: CanvasNode, requestId: string, count: number): GenerationApprovalItem {
  const spec = approvedSpec(node);
  return {
    requestId,
    nodeId: node.id,
    title: node.title || node.type,
    kind: node.type,
    provider: spec.provider,
    ...(spec.model ? { model: spec.model } : {}),
    count,
    retries: nodeReviewSettings(node)?.retries ?? 0,
  };
}
/** What a request an agent wrote itself makes, for the person to approve. */
function requestItem(
  request: MediaRequest,
  requestId: string,
  target?: GenerationJob["target"],
  title?: string,
): GenerationApprovalItem {
  const prompt = "prompt" in request && typeof request.prompt === "string" ? request.prompt : "";
  return {
    requestId,
    ...(target ? { nodeId: target.nodeId } : {}),
    title: title || prompt.slice(0, 80) || request.kind,
    kind: request.kind,
    provider: request.model.provider,
    ...(request.model.id ? { model: request.model.id } : {}),
    count: request.kind === "image" ? (request.outputCount ?? 1) : 1,
    retries: 0,
  };
}
/** What the target keeps of the caller's request: a media model it chose, and its approval. */
function runOptions(input: RunInput): HeldRunOptions | null {
  const model = input.model && input.model.provider !== "bb" ? input.model : undefined;
  if (!model && !input.approvedImagePath) return null;
  return {
    ...(model ? { model } : {}),
    ...(input.approvedImagePath ? { approvedImagePath: input.approvedImagePath } : {}),
  };
}
const runsOnBbNode = (node: Pick<CanvasNode, "type">) =>
  node.type === "text" || node.type === "agent";
