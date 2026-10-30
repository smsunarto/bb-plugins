import type { z } from "zod";
import type { JsonObject } from "../../../shared/json/index.ts";
import type { OpenPanel } from "../../../shared/contracts/engine.ts";
import type { CoverageMode, ProgressUpdate } from "../../../shared/contracts/rpc.ts";
import type { SelectionHandoff } from "../../../shared/contracts/selection-handoff.ts";
import { errorMessage } from "../../../shared/error-message.ts";
import { type AgentSelection, selectionMarkdown } from "../../../shared/review/agent-selection.ts";
import { documentText } from "../../../shared/review/document-text.ts";
import { type FileLineRange, ReviewInputError } from "../../../shared/review/document.ts";
import type { SourcePins } from "../../../shared/review/source.ts";
import { scopedCoverage } from "../../../shared/review/viewed-coverage.ts";
import { resolveReviewStackLayers } from "../host-io/review-stack.ts";
import type { activitySchema } from "./activity.ts";
import { type InstructionTopic, renderInstructions } from "./instructions.ts";
import type { LocalReviewData, uploadSchema } from "./local-data.ts";
import {
  type UncategorizedReport,
  lensReport,
  reviewProgress,
  uncategorizedReport,
} from "./review-progress.ts";
import {
  type LiveSnapshot,
  type ReviewStore,
  SCRATCHPAD_ID,
  type Snapshot,
  type commandSchema,
  inspectSnapshot,
} from "./store.ts";

export interface AuthoringCapabilities {
  desktopAvailable: boolean;
  softwareMapEnabled: boolean;
  /** Off, the host neither makes nor lists the scratchpad, and refuses its id. */
  scratchpadEnabled: boolean;
}

export interface ReviewApiDeps {
  store: ReviewStore;
  data: LocalReviewData;
  /** Shows a session to the calling thread. Without it, opens refuse. */
  open?: OpenPanel;
  capabilities?: () =>
    | Omit<AuthoringCapabilities, "scratchpadEnabled">
    | Promise<Omit<AuthoringCapabilities, "scratchpadEnabled">>;
  /** Synchronous: the catalog reads it on every listing. */
  scratchpadEnabled?: () => boolean;
  /** Which server this is, for whiteboard_status. */
  status?: () => JsonObject;
  /** A session id as reads name it: the "scratchpad" alias becomes this thread's pad. */
  resolveId?: (id: string) => string;
  /** As `resolveId`, and refuses ids that cannot be written, such as the legacy shared pad. */
  writableId?: (id: string) => string;
}

/** The current version, or a stored one. Reads without a version see the live source. */
type At = { reviewId: string; version?: number };

/** Where source comes from: the session's comparison (at `generation` for a
 * worktree), one `commit` of it, or a reference's own pins. */
export type SourceSelector = At & {
  generation?: string;
  commit?: string;
  repositoryId?: string;
  head?: string;
  base?: string;
};

export type CommandInput = z.output<typeof commandSchema>;
export type ActivityInput = { reviewId: string } & z.output<typeof activitySchema>;
export type UploadInput = z.output<typeof uploadSchema>;
export type InspectInput = At & { targetId?: string; full?: boolean; format?: "text" | "json" };
export type FileInput = SourceSelector & {
  side: "base" | "head";
  file: string;
  projection?: "raw" | "comparison";
};
export type TreeInput = Omit<SourceSelector, "generation"> & {
  side?: "base" | "head";
  path?: string;
};
export type DiffInput = SourceSelector & {
  /** Pathspec, like `git diff -- a b`. Omitted, every changed file. */
  paths?: string[];
  format?: "files" | "patch";
  context?: number;
  maxBytes?: number;
  /** Legacy: `paths: [file], format: "patch"`. */
  file?: string;
};

export type ReviewApi = ReturnType<typeof createReviewApi>;
export type LiveSession = Awaited<ReturnType<ReviewApi["liveSession"]>>;

const SCRATCHPAD_DISABLED =
  "The scratchpad is off. Turn it on in the Whiteboard plugin settings in bb.";

/** Aggregate input budgets, in UTF-8 bytes of the input's JSON. */
const COMMAND_BUDGET = { bytes: 1024 * 1024, label: "1 MiB" };
const UPLOAD_BUDGET = { bytes: 8 * 1024 * 1024, label: `${8 * 1024 * 1024} bytes` };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Measures any JSON input against its budget.
function assertWithinBudget(input: unknown, budget: { bytes: number; label: string }) {
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > budget.bytes)
    throw new ReviewInputError(`Request body exceeds ${budget.label}.`);
}

/**
 * Whiteboard's operations for the app's RPC methods and the agent tools: one
 * async function per operation. Each takes typed input with an explicit
 * `reviewId`, answers a domain value, and throws `ReviewInputError`,
 * `HostUnavailableError`, `ZodError` or an unexpected error for the boundary
 * to report. Callers run operations inside `Engine.run`, which supplies the
 * thread context the scratchpad aliases and `open` read.
 */
export function createReviewApi(deps: ReviewApiDeps) {
  const { store, data, open } = deps;
  const capabilities =
    deps.capabilities ?? (() => ({ desktopAvailable: Boolean(open), softwareMapEnabled: false }));
  const scratchpadEnabled = deps.scratchpadEnabled ?? (() => false);
  const status = deps.status ?? (() => ({}));
  const resolveId = deps.resolveId ?? ((id: string) => id);
  const writableId = deps.writableId ?? ((id: string) => id);

  /** A read without a version sees each worktree session's current source. */
  const fresh = (version?: number) =>
    version === undefined ? store.refreshWorktrees() : Promise.resolve();

  // The host that can show the scratchpad keeps it: a bb thread, while the
  // setting is on. A pad made earlier stays in the store while it is off.
  const ensureScratchpad = async (id?: string) => {
    if (
      open &&
      scratchpadEnabled() &&
      store.scratchpadId() &&
      (!id || id === SCRATCHPAD_ID || id === store.scratchpadId())
    )
      await store.ensureScratchpad();
  };

  const refuseDisabledScratchpad = (id: string) => {
    if ((id === SCRATCHPAD_ID || id === store.scratchpadId()) && !scratchpadEnabled())
      throw new ReviewInputError(SCRATCHPAD_DISABLED, 409);
  };

  /** The canonical id of the session an operation names, through the alias
   * rule its access needs; a disabled scratchpad is refused. */
  const session = async (id: string, access: "read" | "write") => {
    const resolved = access === "read" ? resolveId(id) : writableId(id);
    refuseDisabledScratchpad(resolved);
    await ensureScratchpad(resolved);
    return resolved;
  };

  const readSourceReview = async (id: string, version?: number, generation?: string) => {
    const snapshot = store.read(id, version);
    return generation === undefined
      ? snapshot
      : await data.sourceAtGeneration(snapshot, generation);
  };

  const resolveSelected = async (id: string, input: SourceSelector) =>
    data.resolveSource(
      await readSourceReview(id, input.version, input.generation),
      input.commit,
      explicitPins(input),
    );

  const catalog = (mode: CoverageMode) => {
    const scratchpadId = store.scratchpadId();
    const rows = store
      .list(mode)
      .filter(
        (summary) =>
          summary.kind !== "scratchpad" ||
          (scratchpadEnabled() && summary.reviewId === (scratchpadId ?? SCRATCHPAD_ID)),
      );
    // Outside a thread, the pad listed is the shared one older versions made.
    const legacy = scratchpadId ? undefined : rows.find((row) => row.reviewId === SCRATCHPAD_ID);
    if (legacy) legacy.title = "Legacy shared scratchpad (read-only)";
    return rows;
  };

  /** Show a session in the calling thread. */
  const openReview = async (review: Snapshot) => {
    if (!open)
      throw new ReviewInputError(
        "Whiteboard cannot show sessions here: no bb thread is connected.",
        409,
      );
    return open({ reviewId: review.reviewId, title: review.title });
  };

  /**
   * A created or returned session is shown where the caller can see it. It is
   * already saved, so a failed open is reported, not thrown.
   */
  const openCreated = async (reviewId: string) => {
    try {
      if (!open || !(await capabilities()).desktopAvailable) return { opened: false };
      return { opened: true, ...(await openReview(store.read(reviewId))) };
    } catch (error) {
      return {
        opened: false,
        openError: `${errorMessage(error)} Retry with whiteboard_session_open.`,
      };
    }
  };

  /** After a lens write: the changed lines still uncategorized at that
   * version, so the author can fill the gaps. A comparison that cannot be
   * read leaves a warning instead of failing the saved write. */
  const lensGaps = async (
    reviewId: string,
    version: number,
    signal: AbortSignal,
  ): Promise<{ uncategorized?: UncategorizedReport; warnings?: string[] }> => {
    try {
      return {
        uncategorized: uncategorizedReport(
          await reviewProgress(store, data, store.read(reviewId, version), signal),
        ),
      };
    } catch (error) {
      return { warnings: [`Uncategorized changes are unavailable: ${errorMessage(error)}`] };
    }
  };

  return {
    async status() {
      return { ...status(), desktopAvailable: (await capabilities()).desktopAvailable };
    },

    async capabilities() {
      return { ...(await capabilities()), scratchpadEnabled: scratchpadEnabled() };
    },

    // Server-owned state only: asking a client would let a stalled renderer
    // block the first instructions call.
    async instructions(input: { topic?: InstructionTopic }) {
      return renderInstructions(input.topic ?? "authoring", {
        desktopAvailable: Boolean(open),
        scratchpadEnabled: scratchpadEnabled(),
      });
    },

    /** Home's rows: every session, the scratchpad only while it is on. */
    async catalog(input: { mode?: CoverageMode }) {
      await fresh();
      await ensureScratchpad();
      return catalog(input.mode ?? "structural");
    },

    /** The current document as live views follow it. */
    async liveSession(input: { reviewId: string }) {
      const id = await session(input.reviewId, "read");
      await fresh();
      return {
        ...store.read(id),
        activity: store.activity.read(id),
        coverageRevision: data.coverageRevision,
      };
    },

    /** A stored version in full. It bypasses the refresh loop, so its pins are probed here. */
    async sessionVersion(input: { reviewId: string; version: number }) {
      const id = await session(input.reviewId, "read");
      const snapshot: LiveSnapshot = {
        ...store.read(id, input.version),
        live: { kind: "available", unavailableAnchors: [] },
      };
      try {
        await data.sourcePins(snapshot);
      } catch (error) {
        if (!(error instanceof ReviewInputError) || error.status !== 404) throw error;
        snapshot.live = { kind: "unavailable" };
      }
      return snapshot;
    },

    /** The text outline, one component, or the raw snapshot. */
    async inspect(input: InspectInput) {
      const id = await session(input.reviewId, "read");
      await fresh(input.version);
      const snapshot: LiveSnapshot =
        input.version === undefined
          ? store.read(id)
          : {
              ...store.read(id, input.version),
              live: { kind: "available", unavailableAnchors: [] },
            };
      if ((input.format ?? "text") === "text")
        return documentText(snapshot, input.targetId, Boolean(input.full));
      if (input.targetId !== undefined) return inspectSnapshot(snapshot, input.targetId);
      return input.full ? snapshot : inspectSnapshot(snapshot);
    },

    async history(input: { reviewId: string }) {
      const id = await session(input.reviewId, "read");
      await fresh();
      return store.history(id);
    },

    async activity(input: ActivityInput) {
      const { reviewId, ...update } = input;
      const id = await session(reviewId, "write");
      store.assertExists(id);
      return store.activity.update(id, update);
    },

    async open(input: { reviewId: string }) {
      const id = await session(input.reviewId, "write");
      return { ok: true, ...(await openReview(store.read(id))) };
    },

    /**
     * Run one command. `open` steers presentation, not the saved session, so
     * it stays out of the command and its receipt: a retry may choose
     * differently. It applies to creates only.
     */
    async command(input: CommandInput, options: { open?: boolean; signal: AbortSignal }) {
      assertWithinBudget(input, COMMAND_BUDGET);
      const operation =
        "reviewId" in input.operation
          ? { ...input.operation, reviewId: await session(input.operation.reviewId, "write") }
          : input.operation;
      if (operation.type === "create" && operation.source === "scratchpad")
        refuseDisabledScratchpad(SCRATCHPAD_ID);

      const result = await store.execute({ ...input, operation });

      if (operation.type === "lens") {
        const gaps = await lensGaps(result.reviewId, result.version, options.signal);
        return {
          ...result,
          ...gaps,
          ...(gaps.warnings && { warnings: [...(result.warnings ?? []), ...gaps.warnings] }),
        };
      }
      if (operation.type !== "create") return result;

      return {
        ...result,
        review: store.summary(result.reviewId),
        ...(options.open === false ? { opened: false } : await openCreated(result.reviewId)),
      };
    },

    // A lens author's cheap read: the lenses as authored, what each resolves
    // to, and the changed lines no lens selects yet.
    async lenses(input: { reviewId: string }, options: { signal: AbortSignal }) {
      const id = await session(input.reviewId, "read");
      await fresh();
      const snapshot = store.read(id);
      return {
        version: snapshot.version,
        ...lensReport(
          snapshot.lenses ?? [],
          await reviewProgress(store, data, snapshot, options.signal),
        ),
      };
    },

    /** Viewed coverage. `wait: false` answers a pending comparison's partial progress
     * instead of waiting for it. */
    async progress(
      input: At & { mode?: CoverageMode; generation?: string; wait?: boolean },
      options: { signal: AbortSignal },
    ) {
      const id = await session(input.reviewId, "read");
      await fresh(input.version);
      const mode = input.mode ?? "structural";
      const snapshot = await readSourceReview(id, input.version, input.generation);
      const documentPins =
        input.wait === false && snapshot.source
          ? (await data.resolveSource(snapshot)).pins
          : undefined;
      if (documentPins) {
        const state = data.coverageSnapshot(snapshot.reviewId, documentPins, mode);
        if (state.pending)
          return reviewProgress(store, data, snapshot, options.signal, mode, state.comparison);
      }
      return reviewProgress(store, data, snapshot, options.signal, mode);
    },

    /** Mark files viewed or unviewed by the fingerprints the reader saw. */
    async markProgress(
      input: { reviewId: string; mode?: CoverageMode } & Omit<ProgressUpdate, "mode">,
      options: { signal: AbortSignal },
    ) {
      const id = await session(input.reviewId, "write");
      const mode = input.mode ?? "structural";
      const snapshot = store.read(id);
      const progress = await reviewProgress(store, data, snapshot, options.signal, mode);
      const files = input.files.map((update) => {
        const file = progress.files.find((candidate) => candidate.path === update.path);
        if (!file || file.fingerprint !== update.fingerprint)
          throw new ReviewInputError("This file changed. Reload before marking it viewed.", 409);
        return {
          path: file.path,
          fingerprint: file.fingerprint,
          scope: scopedCoverage(file, update.sources),
        };
      });
      if (store.read(id).version !== snapshot.version)
        throw new ReviewInputError("The Whiteboard changed during this update. Try again.", 409);
      store.updateViewedCoverage(id, files, input.viewed);
      return reviewProgress(store, data, store.read(id, input.version), options.signal, mode);
    },

    /** bb prepares no language checkouts, so there is nothing to retry. */
    async environment(input: { reviewId: string }) {
      const id = await session(input.reviewId, "write");
      return { issues: await data.environmentIssues(store.read(id)) };
    },

    /** bb prepares no language checkouts, so no cleanup can have failed. */
    async workspaceCleanup(input: { workspaceId?: string }) {
      if (input.workspaceId) throw new ReviewInputError("Cleanup failure not found.", 404);
      return { failures: [] };
    },

    async registerRepository(input: { path: string }) {
      return data.register(input.path);
    },

    async resolvePins(input: { repositoryId: string; base: string; head: string }) {
      return data.resolvePins(input.repositoryId, input.base, input.head);
    },

    async upload(input: UploadInput) {
      assertWithinBudget(input, UPLOAD_BUDGET);
      return data.upload(input);
    },

    /** An exact range of source, at the target or explicit pins. */
    async source(input: At & { source: FileLineRange; commit?: string }) {
      const id = await session(input.reviewId, "write");
      const { pins } = await data.resolveSource(
        store.read(id, input.version),
        input.commit,
        input.source.pins,
      );
      return data.quote(pins, input.source);
    },

    /** A whole file. Live head bytes of a worktree comparison also name the local file. */
    async file(input: FileInput) {
      const id = await session(input.reviewId, "read");
      await fresh(input.version);
      const anchor = explicitPins(input);
      const { snapshot, pins } = await resolveSelected(id, input);
      const file = await data.file(
        pins,
        input.side,
        input.file,
        false,
        input.projection === "comparison",
      );
      const local =
        !input.commit &&
        !anchor &&
        (input.version === undefined || input.generation !== undefined) &&
        (input.generation === undefined ||
          store.read(id).source?.pins.worktreeRevision === input.generation) &&
        input.side === "head" &&
        snapshot.source?.target.kind === "worktree"
          ? await data.liveFile(pins.repositoryId, input.file, file.text)
          : undefined;
      return { ...file, ...local };
    },

    async tree(input: TreeInput) {
      const id = await session(input.reviewId, "read");
      await fresh(input.version);
      const { pins } = await data.resolveSource(
        store.read(id, input.version),
        input.commit,
        explicitPins(input),
      );
      return data.tree(pins, input.side ?? "head", input.path ?? "");
    },

    /** The changed files the selector compares, narrowed to a pathspec. */
    async changedFiles(input: SourceSelector & { paths?: string[] }) {
      const id = await session(input.reviewId, "read");
      await fresh(input.version);
      return data.changedFiles((await resolveSelected(id, input)).pins, input.paths);
    },

    /** Changed files, or numbered patches within `maxBytes`. */
    async diff(input: DiffInput) {
      if (input.file !== undefined && (input.paths || input.format !== undefined))
        throw new ReviewInputError(
          'file cannot be combined with paths or format; use paths:["…"], format:"patch".',
        );
      const id = await session(input.reviewId, "read");
      await fresh(input.version);
      const { pins } = await resolveSelected(id, input);
      if ((input.format ?? "files") === "files" && input.file === undefined)
        return { format: "files" as const, files: await data.changedFiles(pins, input.paths) };
      return {
        format: "patch" as const,
        text: await data.patches(pins, {
          paths: input.file === undefined ? input.paths : [input.file],
          contextLines: input.context,
          maxBytes: input.maxBytes ?? 40_000,
        }),
      };
    },

    async commits(input: At) {
      const id = await session(input.reviewId, "read");
      await fresh(input.version);
      return data.commits((await data.resolveSource(store.read(id, input.version))).pins);
    },

    async stack(input: At) {
      const id = await session(input.reviewId, "read");
      await fresh(input.version);
      const snapshot = store.read(id, input.version);
      if (!snapshot.source) return { layers: [] };
      const repoKey = (review: Pick<Snapshot, "origin" | "source">) =>
        review.origin?.pullRequestUrl?.replace(/\/pull\/\d+.*$/, "") ??
        review.source?.pins.repositoryId ??
        "";
      const layers = await resolveReviewStackLayers(
        { pullRequestUrl: snapshot.origin?.pullRequestUrl },
        store.list().map((review) => ({
          uuid: review.reviewId,
          title: review.title,
          repoKey: repoKey(review),
          pullRequestNumber: review.origin?.pullRequestNumber,
          presentedDocumentRevision: String(review.version),
        })),
        undefined,
        // gh runs on the host that holds this session's checkout.
        { repositoryId: snapshot.source.pins.repositoryId },
      );
      return { layers };
    },

    async map(input: At & { resourceId: string; generation?: string }) {
      const id = await session(input.reviewId, "read");
      await fresh(input.version);
      return data.map(
        await data.sourcePins(await readSourceReview(id, input.version, input.generation)),
        input.resourceId,
      );
    },

    /** An uploaded resource's bytes. A session with pins serves only its repository's. */
    async resource(input: { reviewId: string; resourceId: string }) {
      const id = await session(input.reviewId, "read");
      await fresh();
      const snapshot = store.read(id);
      const resource = store.resource(input.resourceId);
      if (snapshot.source && resource.repositoryId !== snapshot.source.pins.repositoryId)
        throw new ReviewInputError("Resource is outside this repository.", 404);
      return { mimeType: resource.mimeType, data: resource.data };
    },

    /** The clipboard text for a selection, and bb's "Add to chat" handoff. */
    async copyContext(input: At & { selection: AgentSelection }) {
      const { selection } = input;
      const reviewId = await session(input.reviewId, "write");
      if (selection.apiSource && selection.apiSource.reviewId !== reviewId)
        throw new ReviewInputError("Selection belongs to another Whiteboard.");
      const snapshot = store.read(reviewId, selection.apiSource?.version ?? input.version);
      const target = selection.target;
      let excerpt = "";

      if (target.kind === "code" && !selection.selectedDiff) {
        const source = await data.quote(
          (
            await data.resolveSource(
              snapshot,
              selection.apiSource?.commit,
              selection.apiSource?.pins,
            )
          ).pins,
          {
            side: target.side,
            file: target.path,
            fromLine: target.startLine,
            toLine: target.endLine,
          },
        );
        excerpt =
          `## ${target.side}: ${target.path}:${target.startLine}-${target.endLine} (${source.commit})\n` +
          source.text
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n");
      }

      const diff = selection.selectedDiff;
      const text = selectionMarkdown(
        selection,
        excerpt,
        diff ? { base: `a/${diff.oldPath}`, head: `b/${diff.newPath}` } : undefined,
      );
      const pinned = selection.apiSource?.pins;

      return {
        text: [
          `Selected ${target.kind === "text" ? "text" : "code"} from Whiteboard: ${snapshot.title}`,
          `Session ID: ${snapshot.reviewId}`,
          `Version: ${snapshot.version}`,
          ...(selection.apiSource?.commit
            ? [`Selected commit: ${selection.apiSource.commit}`]
            : []),
          ...(pinned
            ? [
                `Selected repository ID: ${pinned.repositoryId}`,
                ...(pinned.base ? [`Selected base: ${pinned.base}`] : []),
                `Selected head: ${pinned.head}`,
              ]
            : []),
          ...(snapshot.source
            ? [
                `Repository ID: ${snapshot.source.pins.repositoryId}`,
                `Session base: ${snapshot.source.pins.base}`,
                `Session head: ${snapshot.source.pins.head}`,
              ]
            : []),
          `Read this version with whiteboard_session_get({"sessionId":"${snapshot.reviewId}","version":${snapshot.version},"full":true}).`,
          "",
          text,
          "",
          "",
        ].join("\n"),
        // bb's "Add to chat" quotes the selection alone and pills the session
        // (selection-handoff.ts); `text` stays the clipboard copy.
        handoff: {
          quote: target.kind === "text" ? target.quote : text,
          sessionId: snapshot.reviewId,
          version: snapshot.version,
          title: snapshot.title,
        } satisfies SelectionHandoff,
      };
    },
  };
}

/** A read at a reference's own pins instead of the session's target, or undefined. */
function explicitPins(input: { repositoryId?: string; head?: string; base?: string }) {
  if (!input.repositoryId && !input.head && !input.base) return undefined;
  if (!input.repositoryId || !input.head)
    throw new ReviewInputError("Reading at explicit pins needs both repositoryId and head.");
  const pins: SourcePins = { repositoryId: input.repositoryId, head: input.head };
  if (input.base) pins.base = input.base;
  return pins;
}
