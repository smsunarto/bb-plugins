import { experimental_useCodeTheme as useCodeTheme } from "@get-bb/plugin-sdk/app";
import { getSingularPatch, parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { API_ORIGIN, API_PREFIX } from "../../shared/contracts/api-tunnel.ts";
import type {
  ReviewCommitScope,
  ReviewDiffFileWire,
  ReviewDiffLayout,
  ReviewDiffLens,
  ReviewDiffProgress,
  ReviewDiffProgressFile,
  ReviewDiffSide,
  ReviewDiffViewFactory,
  ReviewDiffViewHandle,
  ReviewDiffViewSpec,
  ReviewDiffViewport,
  ReviewDisposable,
  ReviewFindQuery,
  ReviewInlineEditorHandle,
  ReviewInlineEditorSpec,
  ReviewSourcePins,
  ReviewSourceView,
} from "../../shared/vendor/review-protocol/src/index.ts";
import { compactDiffCount } from "../vendor/review/app/src/diff-count.tsx";
import { Chevron, DiffFileTree, StatusGlyph, countsTooltip } from "./diff-file-tree.tsx";
import type { SurfaceEvents } from "./events.ts";
import { findSurfaceMatches, type SurfaceMatch } from "./find.ts";
import type { Portals } from "./portals.tsx";
import {
  type PierreLineRange,
  type SelectionSource,
  type SelectionSurface,
  trackSelection,
} from "./selection.ts";
import {
  type Gap,
  type SideText,
  alignRows,
  foldGaps,
  lensContext,
  lensFiles,
  lensRangesFor,
  orderDiffFiles,
  resolveSide,
  rowOfLine,
  segmentPatch,
  segments,
  sidePath,
  sideText,
} from "./two-side.ts";

/**
 * The Diffs view and the code peeks on `@pierre/diffs` (design §1.5, §1.6,
 * §3.8). A port of the Desktop host's `reviewDiffViewService.ts` and
 * `reviewFilesDiffView.ts`: one controller serves the Diffs page and, in
 * document mode, every code peek, as Desktop does (`createDocument`).
 *
 * Monaco's lensed diff editor becomes: full base and head text read through
 * `/file`, `parseDiffFromFile` for the alignment, the fold model in
 * `two-side.ts`, and one pierre `FileDiff` per visible run with true line
 * numbers. Gap bars between runs ("Outside lens", "Viewed", "Unchanged")
 * expand on click, which is the context expansion.
 */

/** Rendered row height of `@pierre/diffs` lines, and Desktop's peek estimate (`DocumentCodeView.tsx`). */
const LINE_HEIGHT = 20;
const HEADER_HEIGHT = 36;
const GAP_HEIGHT = 26;
const SECTION_HEIGHT = 48;
/** Desktop caps a capped peek at 400px (`reviewFilesDiffView.ts`). */
const CAPPED_HEIGHT = 400;

export type Request = (url: string, init?: RequestInit) => Promise<Response>;

/** The shared dependencies of both code-surface factories. */
export interface CodeSurfaceDeps {
  request: Request;
  reviewId?: string;
  portals: Portals;
  events: SurfaceEvents;
  /**
   * The comparison the canvas shows, from `ReviewCanvasContent.setSourceView`
   * (Desktop `apiSource.canvas(() => sourceView, …)`). Without it, reads use
   * the session's latest version and nothing is cached.
   */
  sourceView?: () => ReviewSourceView | undefined;
}

// ---------------------------------------------------------------- reading

/** One comparison's read parameters (`reviewSourceQuery`). */
export interface Comparison {
  reviewId: string;
  version?: number;
  generation?: string;
  commit?: string;
  pins?: ReviewSourcePins;
}

function comparisonQuery(comparison: Comparison): URLSearchParams {
  const params = new URLSearchParams();
  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined) params.set(key, String(value));
  };

  set("version", comparison.version);
  set("commit", comparison.commit);
  set("repositoryId", comparison.pins?.repositoryId);
  set("base", comparison.pins?.base);
  set("head", comparison.pins?.head);

  return params;
}

/** Versions are immutable; a live worktree changes generation. An unknown version is never cached. */
function comparisonKey(comparison: Comparison): string | undefined {
  if (comparison.version === undefined) return undefined;

  return JSON.stringify([
    comparison.reviewId,
    comparison.version,
    comparison.generation ?? "",
    comparison.commit ?? "",
    comparison.pins ?? null,
  ]);
}

/** Reads `/diff?format=files` and `/file` through the bridge tunnel, sharing in-flight and settled reads. */
export interface SourceReader {
  files(comparison: Comparison): Promise<ReviewDiffFileWire[]>;
  text(comparison: Comparison, side: ReviewDiffSide, path: string): Promise<string>;
}

const READ_CACHE_LIMIT = 256;

export function createSourceReader(request: Request): SourceReader {
  const cache = new Map<string, Promise<unknown>>();
  const read = <T,>(comparison: Comparison, route: string, extra: Record<string, string>) => {
    const params = comparisonQuery(comparison);

    for (const [key, value] of Object.entries(extra)) params.set(key, value);
    const url = `${API_ORIGIN}${API_PREFIX}/${encodeURIComponent(comparison.reviewId)}${route}?${params}`;
    const base = comparisonKey(comparison);
    const key = base === undefined ? undefined : `${base}${route}?${params}`;
    const existing = key === undefined ? undefined : cache.get(key);

    if (existing) return existing as Promise<T>;
    const promise = readJson<T>(request, url);

    if (key !== undefined) {
      cache.set(key, promise);
      promise.catch(() => cache.delete(key));

      if (cache.size > READ_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    }

    return promise;
  };

  return {
    files: (comparison) => read(comparison, "/diff", { format: "files" }),
    text: async (comparison, side, path) =>
      (await read<{ text: string }>(comparison, "/file", { side, file: path })).text,
  };
}

async function readJson<T>(request: Request, url: string): Promise<T> {
  const response = await request(url);

  if (!response.ok) {
    let message = `Could not read pinned source (${response.status}).`;

    try {
      const body = (await response.json()) as { error?: unknown };

      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // The status line is the best message left.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

/** A file's two sides, aligned. */
export interface FileModel extends SelectionSurface {
  name: string;
  baseText: SideText;
  headText: SideText;
}

/** Read both sides of one changed file. An unchanged file is read once: both sides are the same bytes. */
export async function loadFileModel(
  reader: SourceReader,
  comparison: Comparison,
  file: ReviewDiffFileWire,
): Promise<FileModel> {
  const base = resolveSide({ ...file, side: "base" });
  const head = resolveSide({ ...file, side: "head" });
  const unchanged = file.status === "unchanged";
  const [headRaw, baseRaw] = await Promise.all([
    head ? reader.text(comparison, "head", head.path) : Promise.resolve(""),
    unchanged
      ? Promise.resolve(null)
      : base
        ? reader.text(comparison, "base", base.path)
        : Promise.resolve(""),
  ]);
  const baseContents = baseRaw ?? headRaw;
  const name = head?.path ?? base?.path ?? file.path;
  const diff = parseDiffFromFile(
    { name: base?.path ?? name, contents: baseContents },
    { name, contents: headRaw },
  );
  const baseText = sideText(baseContents);
  const headText = sideText(headRaw);

  return {
    name,
    basePath: base?.path ?? null,
    headPath: head?.path ?? null,
    rows: alignRows(diff),
    base: baseText.lines,
    head: headText.lines,
    baseText,
    headText,
  };
}

// ---------------------------------------------------------------- store

type Load<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; value: T };

interface Entry {
  key: string;
  file: ReviewDiffFileWire;
  sectionId?: string;
  sectionStart?: boolean;
}

/** A find match in one entry. */
export interface DocumentMatch extends SurfaceMatch {
  entry: string;
  /** The side's file (`previousPath` for a renamed file's base). */
  file: string;
}

interface ViewState {
  status: "loading" | "ready" | "error";
  error?: string;
  entries: readonly Entry[];
  models: ReadonlyMap<string, Load<FileModel>>;
  progress?: ReviewDiffProgress;
  collapsed: ReadonlySet<string>;
  collapsedSections: ReadonlySet<string>;
  expanded: ReadonlyMap<string, ReadonlySet<number>>;
  matches: readonly DocumentMatch[];
  activeMatch?: number;
  activePath?: string;
  layout: ReviewDiffLayout;
  /** A row to scroll to once it renders. */
  reveal?: { entry: string; row: number; nonce: number };
}

function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => state,
    set(next: Partial<T>) {
      state = { ...state, ...next };

      // A snapshot: a listener may unsubscribe while the store notifies.
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
}

function emitter<T>() {
  const listeners = new Set<(value: T) => void>();

  return {
    fire(value: T) {
      for (const listener of Array.from(listeners)) listener(value);
    },
    event(listener: (value: T) => void): ReviewDisposable {
      listeners.add(listener);

      return { dispose: () => listeners.delete(listener) };
    },
  };
}

let nextViewId = 0;

/** Where a view reads, what it shows, and who renders it. */
export interface DiffViewSource {
  reader: SourceReader;
  comparison: Comparison;
}

/** The DiffView controller (`DiffViewController` upstream), in Diffs-page or document mode. */
export class DiffViewController {
  readonly id = `whiteboard-diff-${++nextViewId}`;
  readonly store: ReturnType<typeof createStore<ViewState>>;
  private readonly errors = emitter<string>();
  private readonly scrolls = emitter<ReviewDiffViewport>();
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;
  private readonly initialized: Promise<void>;
  private pendingSource?: { source: ReviewDiffLens["ranges"][number]; sectionId?: string };
  private pendingFile?: string;
  private documentCollapsed = false;
  private viewedApplied = new Map<string, string>();
  private sectionViewed = new Map<string, string>();
  private revealNonce = 0;
  private readonly waiters = new Set<() => void>();
  scroller: HTMLElement | null = null;
  readonly selection: ReturnType<typeof trackSelection>;

  constructor(
    readonly spec: ReviewDiffViewSpec,
    private readonly source: DiffViewSource,
    readonly deps: Pick<CodeSurfaceDeps, "portals" | "events" | "reviewId"> & {
      diffLayout?: DiffLayoutSource;
    },
  ) {
    this.store = createStore<ViewState>({
      status: "loading",
      entries: [],
      models: new Map(),
      progress: spec.progress,
      collapsed: new Set(),
      collapsedSections: new Set(),
      expanded: new Map(),
      matches: [],
      layout: spec.document ? "unified" : (deps.diffLayout?.current() ?? "split"),
    });
    this.selection = trackSelection({
      root: spec.container,
      events: deps.events,
      reviewId: deps.reviewId,
      source: () => selectionSource(source.comparison),
    });
    this.cleanups.push(() => this.selection.dispose());

    if (!spec.document && deps.diffLayout) {
      const subscription = deps.diffLayout.onDidChange((layout) => this.store.set({ layout }));

      this.cleanups.push(() => subscription.dispose());
    }
    this.cleanups.push(
      deps.portals.mount({
        id: this.id,
        container: spec.container,
        element: <DiffViewRoot controller={this} />,
      }),
    );

    if (spec.fileTreeContainer && !spec.document)
      this.cleanups.push(
        deps.portals.mount({
          id: `${this.id}:tree`,
          container: spec.fileTreeContainer,
          element: <DiffViewTree controller={this} external />,
        }),
      );
    this.initialized = this.initialize();
  }

  get onDidError() {
    return this.errors.event;
  }

  get onDidScroll() {
    return this.scrolls.event;
  }

  get isDisposed() {
    return this.disposed;
  }

  private async initialize(): Promise<void> {
    try {
      const entries = await loadEntries(this.source, this.spec.lens, this.spec.progress);

      if (this.disposed) return;
      this.store.set({ status: "ready", entries });
      this.setProgress(this.store.get().progress);
      this.setCollapsed(this.documentCollapsed);

      if (this.spec.document) for (const entry of entries) void this.ensureModel(entry.file.path);

      if (this.pendingSource)
        this.revealSource(this.pendingSource.source, this.pendingSource.sectionId);
      else if (this.pendingFile) this.revealFile(this.pendingFile);
    } catch (error) {
      if (this.disposed) return;
      const message = error instanceof Error ? error.message : String(error);

      this.store.set({ status: "error", error: message });
      this.errors.fire(message);
    }
  }

  /** Read a file's sides once; the Diffs page asks as files near the viewport. */
  ensureModel(path: string): Promise<FileModel | undefined> {
    const current = this.store.get().models.get(path);

    if (current?.status === "ready") return Promise.resolve(current.value);

    if (current) return this.whenModel(path);

    // Find can ask before the file list arrives.
    if (this.store.get().status === "loading")
      return this.initialized.then(() => (this.disposed ? undefined : this.ensureModel(path)));
    const entry = this.store.get().entries.find((candidate) => candidate.file.path === path);

    if (!entry) return Promise.resolve(undefined);
    this.setModel(path, { status: "loading" });

    return loadFileModel(this.source.reader, this.source.comparison, entry.file).then(
      (value) => {
        if (!this.disposed) this.setModel(path, { status: "ready", value });

        return value;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);

        if (!this.disposed) {
          this.setModel(path, { status: "error", error: message });

          // A peek has one job; its failure is the peek's ("Inline preview unavailable").
          if (this.spec.document) this.errors.fire(message);
        }

        return undefined;
      },
    );
  }

  private whenModel(path: string): Promise<FileModel | undefined> {
    return new Promise((resolve) => {
      const check = () => {
        const model = this.store.get().models.get(path);

        if (this.disposed || !model || model.status !== "loading") {
          unsubscribe();
          this.waiters.delete(check);
          resolve(model?.status === "ready" ? model.value : undefined);
        }
      };
      const unsubscribe = this.store.subscribe(check);

      // A load that settles after dispose never updates the store; dispose wakes the waiter instead.
      this.waiters.add(check);
      check();
    });
  }

  private setModel(path: string, load: Load<FileModel>) {
    const models = new Map(this.store.get().models);

    models.set(path, load);
    this.store.set({ models });
  }

  /** The progress file an entry reads its counts and viewed folds from. */
  entryProgress(
    entry: Entry,
    progress = this.store.get().progress,
  ): ReviewDiffProgressFile | undefined {
    const files = entry.sectionId
      ? progress?.sections?.find((section) => section.id === entry.sectionId)?.files
      : progress?.files;

    return files?.find((file) => file.path === entry.file.path);
  }

  /** The lens ranges that fold this entry, or none for a whole-file view. */
  entryLens(entry: Entry): ReviewDiffLens["ranges"] | undefined {
    const lens = this.spec.lens;

    if (!lens || lens.wholeFiles) return undefined;
    const section = entry.sectionId
      ? this.store.get().progress?.sections?.find((candidate) => candidate.id === entry.sectionId)
      : undefined;

    return lensRangesFor(section ? section.sources : lens.ranges, entry.file);
  }

  entryGaps(entry: Entry, model: FileModel): Gap[] {
    return foldGaps(model.rows, {
      lens: this.entryLens(entry),
      progress: this.entryProgress(entry),
    });
  }

  setProgress(progress: ReviewDiffProgress | undefined): void {
    if (!progress) return;
    const state = this.store.get();
    const collapsedSections = new Set(state.collapsedSections);

    for (const section of progress.sections ?? []) {
      const previous = this.sectionViewed.get(section.id);

      if (section.state === "viewed" && previous !== "viewed") collapsedSections.add(section.id);
      else if (previous === "viewed" && section.state !== "viewed")
        collapsedSections.delete(section.id);
      this.sectionViewed.set(section.id, section.state);
    }
    // A viewed file collapses; it reopens when unviewed or when its viewed state was just reset.
    const collapsed = new Set(state.collapsed);

    for (const entry of state.entries) {
      const file = this.entryProgress(entry, progress);

      if (!file) continue;
      const previous = this.viewedApplied.get(entry.key);

      if (previous === file.state) continue;

      if (file.state === "viewed") collapsed.add(entry.key);
      else if (previous === "viewed" || progress.changedPaths?.includes(file.path))
        collapsed.delete(entry.key);
      this.viewedApplied.set(entry.key, file.state);
    }
    this.store.set({ progress, collapsedSections, collapsed });
  }

  setCollapsed(collapsed: boolean): void {
    this.documentCollapsed = collapsed;

    if (!this.spec.document) return;
    this.store.set({
      collapsed: new Set(collapsed ? this.store.get().entries.map((entry) => entry.key) : []),
    });
  }

  toggleEntry(key: string): void {
    const collapsed = new Set(this.store.get().collapsed);

    if (!collapsed.delete(key)) collapsed.add(key);
    this.store.set({ collapsed });
  }

  toggleSection(id: string): void {
    const collapsedSections = new Set(this.store.get().collapsedSections);

    if (!collapsedSections.delete(id)) collapsedSections.add(id);
    this.store.set({ collapsedSections });
  }

  expandGap(key: string, start: number): void {
    const expanded = new Map(this.store.get().expanded);

    expanded.set(key, new Set([...(expanded.get(key) ?? []), start]));
    this.store.set({ expanded });
  }

  /** Open whatever hides `row` and scroll it into view. */
  revealRow(entry: Entry, row: number, model: FileModel): void {
    const state = this.store.get();
    const gap = this.entryGaps(entry, model).find(
      (candidate) => candidate.collapsed && row >= candidate.start && row < candidate.end,
    );
    const expanded = new Map(state.expanded);

    if (gap) expanded.set(entry.key, new Set([...(expanded.get(entry.key) ?? []), gap.start]));
    const collapsed = new Set(state.collapsed);

    collapsed.delete(entry.key);
    const collapsedSections = new Set(state.collapsedSections);

    if (entry.sectionId) collapsedSections.delete(entry.sectionId);
    this.store.set({
      expanded,
      collapsed,
      collapsedSections,
      reveal: { entry: entry.key, row, nonce: ++this.revealNonce },
    });
  }

  revealSource(source: ReviewDiffLens["ranges"][number], sectionId?: string): void {
    const state = this.store.get();

    if (state.status !== "ready") {
      this.pendingSource = { source, sectionId };

      return;
    }
    this.pendingSource = undefined;
    const entry = state.entries.find(
      (candidate) =>
        (!sectionId || candidate.sectionId === sectionId) &&
        (!candidate.sectionId ||
          state.progress?.sections
            ?.find((section) => section.id === candidate.sectionId)
            ?.sources.some(
              (range) =>
                range.file === source.file &&
                range.side === source.side &&
                range.fromLine <= source.fromLine &&
                range.toLine >= source.fromLine,
            )) &&
        source.file === sidePath(candidate.file, source.side),
    );

    if (!entry) return;
    void this.ensureModel(entry.file.path).then((model) => {
      if (!model || this.disposed) return undefined;
      const row = rowOfLine(model.rows, source.side, source.fromLine);

      this.revealRow(entry, Math.max(0, row), model);

      return undefined;
    });
  }

  revealFile(path: string): void {
    const state = this.store.get();

    if (state.status !== "ready") {
      this.pendingFile = path;

      return;
    }
    this.pendingFile = undefined;
    const entry = state.entries.find((candidate) => candidate.file.path === path);

    if (!entry) return;
    this.store.set({
      activePath: path,
      reveal: { entry: entry.key, row: -1, nonce: ++this.revealNonce },
    });
  }

  /** Pixels from the diff's top edge to `source`; file order beyond rendered files. */
  sourceOffset(source: ReviewDiffLens["ranges"][number]): number | undefined {
    const state = this.store.get();
    const index = state.entries.findIndex(
      (entry) => sidePath(entry.file, source.side) === source.file,
    );

    if (index < 0) return undefined;
    const entry = state.entries[index];
    const model = state.models.get(entry.file.path);
    const element = [
      ...(this.scroller?.querySelectorAll<HTMLElement>("[data-wb-entry]") ?? []),
    ].find((candidate) => candidate.dataset.wbEntry === entry.key);

    if (this.scroller && element && model?.status === "ready") {
      const row = rowOfLine(model.value.rows, source.side, source.fromLine);
      const within = visibleOffset(
        segments(
          model.value.rows.length,
          this.entryGaps(entry, model.value),
          state.expanded.get(entry.key),
        ),
        Math.max(0, row),
      );

      return (
        element.getBoundingClientRect().top -
        this.scroller.getBoundingClientRect().top +
        HEADER_HEIGHT +
        within
      );
    }
    const active = state.entries.findIndex((candidate) => candidate.file.path === state.activePath);

    return (index - Math.max(0, active)) * 1_000_000 + source.fromLine;
  }

  focus(): void {
    this.scroller?.focus({ preventScroll: true });
  }

  /** Paint find matches; `active` is the current one. */
  decorate(matches: readonly DocumentMatch[], active?: number): void {
    this.store.set({ matches, activeMatch: active });
  }

  scrolled(): void {
    if (this.scroller) this.scrolls.fire({ height: this.scroller.clientHeight });
  }

  /** The topmost file follows the reader passively (`syncFileSelectionFromWidget`). */
  setActivePath(path: string | undefined): void {
    if (path !== this.store.get().activePath) this.store.set({ activePath: path });
  }

  handle(): ReviewDiffViewHandle {
    return {
      focus: () => this.focus(),
      setProgress: (progress) => this.setProgress(progress),
      revealSource: (source, sectionId) => this.revealSource(source, sectionId),
      revealFile: (path) => this.revealFile(path),
      onDidError: this.errors.event,
      onDidScroll: this.scrolls.event,
      sourceOffset: (source) => this.sourceOffset(source),
      dispose: () => this.dispose(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();

    // A find awaiting a model resolves (with nothing) instead of hanging the canvas find.
    for (const wake of this.waiters) wake();
  }
}

/** Pixels from the top of a file body to `row`, over its visible runs and gap bars. */
function visibleOffset(parts: ReturnType<typeof segments>, row: number): number {
  let offset = 0;

  for (const part of parts) {
    if (row >= part.start && row < part.end)
      return offset + (part.kind === "rows" ? (row - part.start) * LINE_HEIGHT : 0);
    offset += part.kind === "rows" ? (part.end - part.start) * LINE_HEIGHT : GAP_HEIGHT;
  }

  return offset;
}

function selectionSource(comparison: Comparison): SelectionSource {
  return {
    reviewId: comparison.reviewId,
    version: comparison.version,
    commit: comparison.commit,
    pins: comparison.pins,
  };
}

/** The entries a view shows, in Desktop order (`ReviewDiffViewService` `initialize` + source `load`). */
export async function loadEntries(
  source: DiffViewSource,
  lens: ReviewDiffLens | undefined,
  progress: ReviewDiffProgress | undefined,
): Promise<Entry[]> {
  const pinsWithoutBase = source.comparison.pins && !source.comparison.pins.base;
  // A reference pinned to one commit has no comparison; its file is context.
  const files = pinsWithoutBase ? [] : await source.reader.files(source.comparison);
  const loaded = lens
    ? lensFiles(files, lens).filter((file) =>
        lens.ranges.some((range) => range.file === sidePath(file, range.side)),
      )
    : orderDiffFiles(files);
  const sections = progress?.sections;

  if (lens && sections?.length)
    return sections.flatMap((section) =>
      loaded
        .filter((file) => lensRangesFor(section.sources, file).length > 0)
        .map((file, index) => ({
          key: `${section.id}:${file.path}`,
          file,
          sectionId: section.id,
          sectionStart: index === 0,
        })),
    );
  // File lenses have no authored sections; follow the file tree's order.
  const ordered = lens ? orderDiffFiles(loaded) : loaded;

  return ordered.map((file) => ({ key: `:${file.path}`, file }));
}

/** The app-wide diff layout (`ReviewCanvasBridge.currentDiffLayout`). */
export interface DiffLayoutSource {
  current(): ReviewDiffLayout;
  onDidChange(listener: (layout: ReviewDiffLayout) => void): ReviewDisposable;
}

// ---------------------------------------------------------------- document mode

/** The comparison a peek reads: its own pins, or the canvas's (`documentScope`). */
export function documentScope(
  view: ReviewSourceView | undefined,
  reviewId: string,
  spec: {
    path: string;
    side: ReviewDiffSide;
    pins?: ReviewSourcePins;
    ranges: ReviewInlineEditorSpec["ranges"];
  },
): { lens: ReviewDiffLens; comparison: Comparison } {
  const current: Comparison = spec.pins
    ? { reviewId: view?.reviewId ?? reviewId, version: view?.version, pins: spec.pins }
    : {
        reviewId: view?.reviewId ?? reviewId,
        version: view?.version,
        generation: view?.generation,
        commit: view?.commit,
        pins: view?.pins,
      };

  return {
    comparison: current,
    lens: {
      id: `document:${JSON.stringify([spec.path, spec.ranges, spec.pins])}`,
      title: spec.path,
      reviewId: current.reviewId,
      version: current.version ?? 0,
      ranges: spec.ranges.map((range) => ({
        file: spec.path,
        side: range.side ?? spec.side,
        fromLine: range.startLine,
        toLine: range.endLine,
      })),
    },
  };
}

/** Find over a peek's lensed files, without rendering them (`findDocument`). */
export async function findDocument(
  source: DiffViewSource,
  lens: ReviewDiffLens,
  query: ReviewFindQuery,
  models?: (path: string) => Promise<FileModel | undefined>,
): Promise<DocumentMatch[]> {
  if (!query.text) return [];
  const entries = await loadEntries(source, lens, undefined);
  const matches: DocumentMatch[] = [];

  for (const entry of entries) {
    const ranges = lensRangesFor(lens.ranges, entry.file);

    if (!ranges.length) continue;
    const model = models
      ? await models(entry.file.path)
      : await loadFileModel(source.reader, source.comparison, entry.file);

    if (!model) continue;
    // A one-sided file has no diff to fold; its ranges alone bound the search.
    const oneSided = model.basePath === null || model.headPath === null;
    const visible = oneSided
      ? model.rows.map((row) =>
          ranges.some((range) => {
            const line = range.side === "base" ? row.base : row.head;

            return line !== null && line + 1 >= range.fromLine && line + 1 <= range.toLine;
          }),
        )
      : lensContext(model.rows, ranges);

    for (const match of findSurfaceMatches({
      rows: model.rows,
      base: model.base,
      head: model.head,
      visible,
      query,
    }))
      matches.push({
        ...match,
        entry: entry.key,
        file: (match.side === "base" ? model.basePath : model.headPath) ?? entry.file.path,
      });
  }

  return matches;
}

/** A code peek: the document mode of the diff view (`createDocument`, `reviewDiffViewService.ts`). */
export function createDocumentView(
  spec: ReviewInlineEditorSpec,
  lens: ReviewDiffLens,
  source: DiffViewSource,
  deps: Pick<CodeSurfaceDeps, "portals" | "events" | "reviewId">,
): ReviewInlineEditorHandle {
  const heights = emitter<number>();
  let height = estimateDocumentHeight(spec);
  let generation = 0;
  let matches: DocumentMatch[] = [];
  let disposed = false;
  const view = new DiffViewController(
    {
      container: spec.container,
      lens,
      progress: spec.progress,
      document: {
        heightMode: spec.heightMode,
        onDidChangeHeight: (value) => {
          if (value === height) return;
          height = value;
          heights.fire(value);
        },
        onDidFocus: spec.onDidFocus,
        onDidOpen: spec.onDidOpen,
      },
    },
    source,
    deps,
  );

  spec.container.classList.toggle("review-document-code-active", spec.active);

  return {
    get height() {
      return height;
    },
    setProgress: (progress) => view.setProgress(progress),
    onDidChangeHeight: heights.event,
    onDidError: view.onDidError,
    setActive: (active) => spec.container.classList.toggle("review-document-code-active", active),
    setCollapsed: (collapsed) => view.setCollapsed(collapsed),
    setFindQuery: async (query) => {
      const request = ++generation;
      const found = await findDocument(source, lens, query, (path) => view.ensureModel(path));

      if (disposed || request !== generation) return { matchCount: 0 };
      matches = found;
      view.decorate(matches);

      return { matchCount: matches.length };
    },
    revealFindMatch: (index) => {
      const match = matches[index];

      if (!match) return;
      view.setCollapsed(false);
      const state = view.store.get();
      const entry = state.entries.find((candidate) => candidate.key === match.entry);
      const model = entry && state.models.get(entry.file.path);

      if (entry && model?.status === "ready") view.revealRow(entry, match.row, model.value);
      view.decorate(matches, index);
    },
    clearActiveFindMatch: () => view.decorate(matches),
    clearFind: () => {
      generation++;
      matches = [];
      view.decorate([]);
    },
    dispose: () => {
      disposed = true;
      generation++;
      view.dispose();
    },
  };
}

/** Desktop's pre-mount estimate (`DocumentCodeView.tsx` `estimatedHeight`). */
function estimateDocumentHeight(spec: ReviewInlineEditorSpec): number {
  const lines = spec.ranges.reduce(
    (total, range) =>
      total +
      range.endLine -
      range.startLine +
      1 +
      Math.min(3, Math.max(0, range.startLine - 1)) +
      3,
    0,
  );
  const content = Math.max(1, lines) * LINE_HEIGHT + HEADER_HEIGHT;

  return spec.heightMode === "capped" ? Math.min(CAPPED_HEIGHT, content) : content;
}

/** Content height to the peek's reported height (`max(40, h)`, capped at 400). */
export function documentHeight(content: number, heightMode: ReviewInlineEditorSpec["heightMode"]) {
  const value = Math.max(40, Math.ceil(content));

  return heightMode === "capped" ? Math.min(CAPPED_HEIGHT, value) : value;
}

// ---------------------------------------------------------------- factory

/** The Diffs view on `@pierre/diffs` (design §3.8). */
export function createDiffView(
  deps: Omit<CodeSurfaceDeps, "events"> & {
    events: SurfaceEvents;
    diffLayout?: DiffLayoutSource;
  },
): ReviewDiffViewFactory {
  const reader = createSourceReader(deps.request);
  const comparison = (scope?: ReviewCommitScope): Comparison => {
    const view = deps.sourceView?.();
    const reviewId = view?.reviewId ?? deps.reviewId;

    if (!reviewId) throw new Error("No Whiteboard session is open.");

    return {
      reviewId,
      version: view?.version,
      generation: view?.generation,
      pins: view?.pins,
      commit: scope?.commit ?? view?.commit,
    };
  };

  return {
    create: (spec) => {
      let current: Comparison;

      try {
        current = comparison(spec.scope);

        if (spec.lens && (spec.scope || spec.lens.reviewId !== current.reviewId))
          throw new Error("A lens must use its review comparison.");
      } catch (error) {
        return failedHandle(error);
      }

      return new DiffViewController(spec, { reader, comparison: current }, deps).handle();
    },
    files: async (scope) => reader.files(comparison(scope)),
  };
}

/** A handle whose initialization already failed: the error arrives through `onDidError`. */
function failedHandle(error: unknown): ReviewDiffViewHandle {
  const message = error instanceof Error ? error.message : String(error);

  return {
    focus() {},
    onDidError: (listener) => {
      queueMicrotask(() => listener(message));

      return { dispose() {} };
    },
    dispose() {},
  };
}

// ---------------------------------------------------------------- rendering

function useView(controller: DiffViewController): ViewState {
  return useSyncExternalStore(
    controller.store.subscribe,
    controller.store.get,
    controller.store.get,
  );
}

function DiffViewRoot({ controller }: { controller: DiffViewController }) {
  const state = useView(controller);
  const document = controller.spec.document;
  const content = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    controller.scroller = scroller.current;

    return () => {
      if (controller.scroller === scroller.current) controller.scroller = null;
    };
  }, [controller]);

  // A peek's height follows its content (`onDidChangeContentHeight`), once
  // its files have read; until then it keeps the estimate, so it never shrinks
  // to a loading row and grows back.
  const settled =
    state.status === "error" ||
    (state.status === "ready" &&
      state.entries.every((entry) => {
        const model = state.models.get(entry.file.path);

        return (
          state.collapsed.has(entry.key) || (model !== undefined && model.status !== "loading")
        );
      }));

  useLayoutEffect(() => {
    const element = content.current;

    if (!document || !element || !settled) return;
    const report = () =>
      document.onDidChangeHeight(
        documentHeight(element.scrollHeight || estimateContent(controller), document.heightMode),
      );

    report();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);

    observer.observe(element);

    return () => observer.disconnect();
  }, [controller, document, settled, state]);

  const body =
    state.status === "error" ? (
      <div
        className="review-diff-view-error px-3 py-2 text-[12px] text-[var(--change-removed)]"
        role="alert"
      >
        {state.error}
      </div>
    ) : state.status === "loading" ? (
      <output className="review-structural-stream-status loading block px-3 py-2 text-[12px] text-[var(--ink-faint)]">
        Loading diff…
      </output>
    ) : (
      <EntryList controller={controller} state={state} />
    );

  if (document)
    return (
      <div
        ref={scroller}
        className="review-files-editor review-files-editor--document h-full overflow-y-auto"
        onFocusCapture={() => document.onDidFocus?.()}
        onPointerDownCapture={() => document.onDidFocus?.()}
      >
        <div ref={content}>{body}</div>
      </div>
    );

  return (
    <div className="review-files-editor @container flex h-full min-h-0 w-full">
      {controller.spec.fileTreeContainer ? null : (
        <div className="review-files-editor-tree hidden w-[260px] shrink-0 border-r border-[var(--rule)] @[500px]:block">
          <DiffViewTree controller={controller} />
        </div>
      )}
      <div
        ref={scroller}
        tabIndex={-1}
        className="review-files-editor-diffs min-w-0 flex-1 overflow-y-auto outline-none"
        onScroll={() => {
          controller.scrolled();
          syncActiveFile(controller);
        }}
      >
        <div ref={content}>{body}</div>
      </div>
    </div>
  );
}

function estimateContent(controller: DiffViewController): number {
  const state = controller.store.get();

  return state.entries.reduce((total, entry) => {
    if (state.collapsed.has(entry.key)) return total + HEADER_HEIGHT;
    const model = state.models.get(entry.file.path);

    if (model?.status !== "ready") return total + HEADER_HEIGHT + LINE_HEIGHT;
    const parts = segments(
      model.value.rows.length,
      controller.entryGaps(entry, model.value),
      state.expanded.get(entry.key),
    );

    return total + HEADER_HEIGHT + visibleOffset(parts, Number.MAX_SAFE_INTEGER);
  }, 0);
}

function syncActiveFile(controller: DiffViewController) {
  const scroller = controller.scroller;

  if (!scroller) return;
  const top = scroller.getBoundingClientRect().top;

  for (const element of scroller.querySelectorAll<HTMLElement>("[data-wb-entry]")) {
    if (element.getBoundingClientRect().bottom > top + 1) {
      controller.setActivePath(element.dataset.wbPath);

      return;
    }
  }
}

function DiffViewTree({
  controller,
  external = false,
}: {
  controller: DiffViewController;
  external?: boolean;
}) {
  const state = useView(controller);
  const files = useMemo(
    () => [...new Map(state.entries.map((entry) => [entry.file.path, entry.file])).values()],
    [state.entries],
  );

  return (
    <DiffFileTree
      files={files}
      progress={state.progress}
      activePath={state.activePath}
      showFileCounts={!external}
      onReveal={(path) => controller.revealFile(path)}
    />
  );
}

function EntryList({ controller, state }: { controller: DiffViewController; state: ViewState }) {
  const items: ReactNode[] = [];

  for (const entry of state.entries) {
    const section =
      entry.sectionId && entry.sectionStart
        ? state.progress?.sections?.find((candidate) => candidate.id === entry.sectionId)
        : undefined;

    if (section)
      items.push(
        <SectionHeader
          key={`section:${section.id}`}
          controller={controller}
          section={section}
          collapsed={state.collapsedSections.has(section.id)}
        />,
      );

    if (entry.sectionId && state.collapsedSections.has(entry.sectionId)) continue;
    items.push(<EntryItem key={entry.key} controller={controller} state={state} entry={entry} />);
  }

  return <>{items}</>;
}

function SectionHeader({
  controller,
  section,
  collapsed,
}: {
  controller: DiffViewController;
  section: NonNullable<ReviewDiffProgress["sections"]>[number];
  collapsed: boolean;
}) {
  const empty = section.total.additions + section.total.deletions === 0;

  return (
    <div
      className={`review-diff-group flex items-center gap-2 border-b border-[var(--rule)] px-3 ${section.state === "viewed" ? "is-viewed" : ""}`}
      style={{ height: SECTION_HEIGHT }}
    >
      <button
        type="button"
        className="review-diff-group-toggle flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-[13px] font-medium text-[var(--ink)]"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} section: ${section.label}`}
        onClick={() => controller.toggleSection(section.id)}
      >
        <Chevron open={!collapsed} />
        <span className="review-diff-group-title truncate">{section.label}</span>
      </button>
      <span
        className="review-diff-group-counts shrink-0 font-[family-name:var(--wb-font-mono)] text-[11px] tabular-nums text-[var(--ink-muted)]"
        title={empty ? undefined : countsTooltip(section.remaining, section.total)}
      >
        {empty ? (
          "Unchanged"
        ) : section.state === "viewed" ? (
          "Viewed"
        ) : section.state === "folded" ? (
          "Folded"
        ) : (
          <Counts additions={section.remaining.additions} deletions={section.remaining.deletions} />
        )}
      </span>
      <ViewedCheck
        state={section.state}
        label={section.label}
        empty={empty || !controller.spec.onToggleSection}
        onToggle={() => controller.spec.onToggleSection?.(section.id)}
      />
    </div>
  );
}

function EntryItem({
  controller,
  state,
  entry,
}: {
  controller: DiffViewController;
  state: ViewState;
  entry: Entry;
}) {
  const element = useRef<HTMLDivElement>(null);
  const collapsed = state.collapsed.has(entry.key);
  const model = state.models.get(entry.file.path);
  const progress = controller.entryProgress(entry);
  const document = controller.spec.document;

  // Read sides as the file nears the viewport; peeks read eagerly.
  useEffect(() => {
    if (collapsed || model || document) return;
    const target = element.current;

    if (!target || typeof IntersectionObserver === "undefined") {
      void controller.ensureModel(entry.file.path);

      return;
    }
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting))
          void controller.ensureModel(entry.file.path);
      },
      { root: controller.scroller, rootMargin: "800px 0px" },
    );

    observer.observe(target);

    return () => observer.disconnect();
  }, [collapsed, controller, document, entry.file.path, model]);

  // A file reveal scrolls its header to the top.
  useLayoutEffect(() => {
    if (state.reveal?.entry === entry.key && state.reveal.row < 0)
      element.current?.scrollIntoView?.({ block: "start" });
  }, [entry.key, state.reveal]);

  return (
    <div
      ref={element}
      className="review-files-editor-item border-b border-[var(--rule)]"
      data-wb-entry={entry.key}
      data-wb-path={entry.file.path}
    >
      <FileHeader controller={controller} entry={entry} progress={progress} collapsed={collapsed} />
      {collapsed ? null : !model || model.status === "loading" ? (
        <output
          className="block px-3 text-[12px] text-[var(--ink-faint)]"
          style={{
            height: document
              ? LINE_HEIGHT
              : Math.min(40, entry.file.additions + entry.file.deletions + 6) * LINE_HEIGHT,
          }}
        >
          Loading diff…
        </output>
      ) : model.status === "error" ? (
        <div className="px-3 py-2 text-[12px] text-[var(--change-removed)]" role="alert">
          {model.error}
        </div>
      ) : (
        <FileSurface controller={controller} state={state} entry={entry} model={model.value} />
      )}
    </div>
  );
}

function FileHeader({
  controller,
  entry,
  progress,
  collapsed,
}: {
  controller: DiffViewController;
  entry: Entry;
  progress?: ReviewDiffProgressFile;
  collapsed: boolean;
}) {
  const { file } = entry;
  const document = controller.spec.document;
  const onToggleViewed = controller.spec.onToggleViewed;
  // Desktop shows counts only from coverage in the Diffs page and in peeks; a commit diff shows the file's own.
  const counts =
    file.status === "unchanged"
      ? undefined
      : (progress?.remaining ??
        (document || controller.spec.fileTreeContainer
          ? undefined
          : { additions: file.additions, deletions: file.deletions }));
  const note = file.status === "unchanged" ? "Unchanged" : undefined;
  const done =
    progress?.state === "viewed" ? "Viewed" : progress?.state === "folded" ? "Folded" : undefined;

  return (
    <div
      className="review-multidiff-header sticky top-0 z-[1] flex cursor-pointer items-center gap-2 border-b border-[var(--rule)] bg-[var(--wb-surface-raised)] px-3 text-[12px]"
      style={{ height: HEADER_HEIGHT }}
      // The header holds the Open file and viewed buttons, so it cannot be a <button> itself.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      onClick={() => controller.toggleEntry(entry.key)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          controller.toggleEntry(entry.key);
        }
      }}
    >
      <Chevron open={!collapsed} />
      <StatusGlyph status={file.status} />
      <span
        className="review-path-label min-w-0 flex-1 truncate text-left text-[var(--ink)] [direction:rtl]"
        title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
      >
        <bdi>{file.path}</bdi>
      </span>
      {counts || done ? (
        <span
          className={`review-multidiff-counts shrink-0 font-[family-name:var(--wb-font-mono)] text-[11px] tabular-nums ${done ? "review-counts-viewed text-[var(--ink-faint)]" : ""}`}
          aria-label={
            counts && !done
              ? `${counts.additions} lines added, ${counts.deletions} lines removed`
              : undefined
          }
          title={progress ? countsTooltip(progress.remaining, progress.total) : undefined}
        >
          {done ?? <Counts additions={counts!.additions} deletions={counts!.deletions} />}
        </span>
      ) : null}
      {note ? (
        <span className="review-multidiff-note shrink-0 text-[var(--ink-faint)]">{note}</span>
      ) : null}
      {document?.onDidOpen ? (
        <button
          type="button"
          className="review-multidiff-open shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[var(--ink-muted)] hover:bg-[var(--bg)] hover:text-[var(--ink)]"
          title="Open File"
          aria-label="Open File"
          onClick={(event) => {
            event.stopPropagation();
            document.onDidOpen?.();
          }}
        >
          Open file
        </button>
      ) : null}
      {document ? null : (
        <ViewedCheck
          state={progress?.state}
          label={file.path}
          empty={file.status === "unchanged" || !onToggleViewed}
          onToggle={() => onToggleViewed?.(file.path, entry.sectionId)}
        />
      )}
    </div>
  );
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <>
      <span className="review-multidiff-additions text-[var(--change-added)]">
        +{compactDiffCount(additions)}
      </span>{" "}
      <span className="review-multidiff-deletions text-[var(--change-removed)]">
        −{compactDiffCount(deletions)}
      </span>
    </>
  );
}

/** The viewed box (`ReviewViewedCheckbox`): keeps its slot but hides when there is nothing to view. */
function ViewedCheck({
  state,
  label,
  empty,
  onToggle,
}: {
  state?: ReviewDiffProgressFile["state"];
  label: string;
  empty: boolean;
  onToggle(): void;
}) {
  const done = state === "viewed";

  return (
    <button
      type="button"
      // A drawn box with a mixed state (`ReviewViewedCheckbox`), as Desktop draws it.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="checkbox"
      className={`review-viewed-check grid size-[14px] shrink-0 cursor-pointer place-items-center rounded-[3px] border border-[var(--ink-faint)] text-[10px] leading-none ${done ? "bg-[var(--wb-accent)] text-[var(--on-accent)]" : ""} ${empty ? "invisible" : ""}`}
      aria-checked={state === "partial" ? "mixed" : done}
      aria-label={`${done ? "Mark unviewed" : "Mark viewed"}: ${label}`}
      title={
        done
          ? "Click to mark as unviewed"
          : state === "partial"
            ? "Click to mark all as viewed"
            : "Click to mark as viewed"
      }
      disabled={empty}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {done ? "✓" : state === "partial" ? "–" : null}
    </button>
  );
}

function FileSurface({
  controller,
  state,
  entry,
  model,
}: {
  controller: DiffViewController;
  state: ViewState;
  entry: Entry;
  model: FileModel;
}) {
  const gaps = controller.entryGaps(entry, model);
  const parts = segments(model.rows.length, gaps, state.expanded.get(entry.key));
  const matches = state.matches.filter((match) => match.entry === entry.key);
  const active = state.activeMatch === undefined ? undefined : state.matches[state.activeMatch];
  const reveal =
    state.reveal?.entry === entry.key && state.reveal.row >= 0 ? state.reveal : undefined;

  return (
    <div className="review-file-surface" data-wb-surface={entry.key}>
      {parts.map((part) =>
        part.kind === "gap" ? (
          <button
            key={`gap:${part.start}`}
            type="button"
            className="review-diff-gap flex w-full cursor-pointer items-center gap-2 border-y border-[var(--rule)] bg-[var(--surface)] px-3 text-left text-[11px] text-[var(--ink-faint)] hover:text-[var(--ink-muted)]"
            style={{ height: GAP_HEIGHT }}
            data-wb-gap={part.label}
            aria-label={`Show ${part.end - part.start} ${part.label === "Outside lens" ? "lines outside the lens" : `${part.label.toLowerCase()} lines`}`}
            onClick={() => controller.expandGap(entry.key, part.start)}
          >
            <span aria-hidden="true">⋯</span>
            <span>
              {part.label} · {part.end - part.start}{" "}
              {part.end - part.start === 1 ? "line" : "lines"}
            </span>
          </button>
        ) : (
          <PierreSegment
            key={`rows:${part.start}`}
            controller={controller}
            model={model}
            start={part.start}
            end={part.end}
            layout={controller.spec.document ? "unified" : state.layout}
            matches={matches.filter((match) => match.row >= part.start && match.row < part.end)}
            active={
              active &&
              active.entry === entry.key &&
              active.row >= part.start &&
              active.row < part.end
                ? active
                : undefined
            }
            reveal={
              reveal && reveal.row >= part.start && reveal.row < part.end ? reveal : undefined
            }
          />
        ),
      )}
    </div>
  );
}

function PierreSegment({
  controller,
  model,
  start,
  end,
  layout,
  matches,
  active,
  reveal,
}: {
  controller: DiffViewController;
  model: FileModel;
  start: number;
  end: number;
  layout: ReviewDiffLayout;
  matches: readonly DocumentMatch[];
  active?: DocumentMatch;
  reveal?: { row: number; nonce: number };
}) {
  const theme = useCodeTheme();
  const marker = useRef<HTMLDivElement>(null);
  const fileDiff = useMemo(() => {
    const parsed = getSingularPatch(
      segmentPatch({
        path: model.name,
        rows: model.rows,
        base: model.baseText,
        head: model.headText,
        start,
        end,
      }),
    );

    // The gap bar above this run already says what is folded; pierre's own separator would repeat it.
    for (const hunk of parsed.hunks) hunk.collapsedBefore = 0;

    return parsed;
  }, [model, start, end]);
  const findCss = useMemo(() => findHighlightCss(matches, active), [matches, active]);
  const options = useMemo(
    () => ({
      theme: theme.name,
      themeType: theme.mode,
      diffStyle: layout,
      disableFileHeader: true,
      overflow: "scroll" as const,
      hunkSeparators: "simple" as const,
      lineDiffType: "word-alt" as const,
      enableLineSelection: true,
      onLineSelected: (range: PierreLineRange | null) => controller.selection.select(model, range),
      unsafeCSS: findCss,
    }),
    [controller, findCss, layout, model, theme.mode, theme.name],
  );

  useLayoutEffect(() => {
    if (reveal) marker.current?.scrollIntoView?.({ block: "center" });
  }, [reveal]);

  return (
    <div className="review-diff-segment relative" data-wb-rows={`${start}-${end}`}>
      {reveal ? (
        <div
          ref={marker}
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0"
          style={{ top: (reveal.row - start) * LINE_HEIGHT, height: LINE_HEIGHT }}
        />
      ) : null}
      <FileDiff fileDiff={fileDiff} options={options} disableWorkerPool />
    </div>
  );
}

/**
 * Line-level find highlights inside pierre's shadow root, keyed by its row
 * attributes (`data-line`, `data-line-type`). Desktop decorated the exact
 * ranges; pierre exposes no range decorations, so the whole line is tinted.
 */
export function findHighlightCss(
  matches: readonly DocumentMatch[],
  active?: DocumentMatch,
): string {
  const selector = (match: DocumentMatch) =>
    match.side === "base"
      ? `[data-line="${match.line}"][data-line-type="change-deletion"]`
      : `[data-line="${match.line}"]:is([data-line-type="change-addition"],[data-line-type="context"],[data-line-type="context-expanded"])`;
  const lines = [...new Set(matches.filter((match) => match !== active).map(selector))];
  const rules: string[] = [];

  if (lines.length)
    rules.push(
      `${lines.join(",")}{background-color:var(--review-find-match-background) !important}`,
    );

  if (active)
    rules.push(
      `${selector(active)}{background-color:var(--review-find-match-active-background) !important}`,
    );

  return rules.join("\n");
}
