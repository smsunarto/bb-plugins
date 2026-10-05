import {
  experimental_Diff as Diff,
  experimental_SourceCode as SourceCode,
} from "@get-bb/plugin-sdk/app";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { API_ORIGIN, API_PREFIX } from "../../shared/contracts/api-tunnel.ts";
import type {
  ReviewCommitScope,
  ReviewDiffFileWire,
  ReviewDiffLens,
  ReviewDiffProgress,
  ReviewDiffProgressFile,
  ReviewDiffProgressState,
  ReviewDiffSide,
  ReviewDiffViewFactory,
  ReviewDiffViewHandle,
  ReviewDiffViewSpec,
  ReviewDisposable,
  ReviewInlineEditorSpec,
  ReviewSourcePins,
  ReviewSourceView,
} from "../../shared/vendor/review-protocol/src/index.ts";
import type { CoverageProgress } from "../../shared/vendor/review/src/viewed-coverage.ts";
import { ViewedButton } from "../vendor/review/app/src/viewed-button.tsx";
import { Chevron, DiffFileTree, treeCounts } from "./diff-file-tree.tsx";
import type { Portals } from "./portals.tsx";
import { currentDiffLayout, onDidChangeDiffLayout } from "./theme.ts";
import { BASE_SOURCE_NOT_OPENABLE, PINNED_SOURCE_NOT_OPENABLE } from "./verbs.ts";
import {
  contextPatch,
  lensFiles,
  lensRangesFor,
  orderDiffFiles,
  resolveSide,
  sidePath,
  sourcePatch,
  type SourceRange,
} from "./two-side.ts";

export type Request = (url: string, init?: RequestInit) => Promise<Response>;

export interface Comparison {
  reviewId: string;
  version?: number;
  generation?: string;
  commit?: string;
  pins?: ReviewSourcePins;
}

/** Navigation resolves the live file on the server, then bb owns edit/save/find. */
export type OpenSourceFile = (input: {
  reviewId: string;
  version?: number;
  generation?: string;
  path: string;
  pins?: ReviewSourcePins;
  startLine?: number;
  endLine?: number;
}) => Promise<boolean>;

export interface CodeSurfaceDeps {
  request: Request;
  reviewId?: string;
  portals: Portals;
  sourceView?: () => ReviewSourceView | undefined;
  openFile?: OpenSourceFile;
}

export interface SourceReader {
  files(comparison: Comparison): Promise<ReviewDiffFileWire[]>;
  file(
    comparison: Comparison,
    side: ReviewDiffSide,
    path: string,
    projection?: "comparison",
  ): Promise<{ text: string; localPath?: string }>;
}

/** Immutable versions share reads. Unversioned worktree reads never cache stale text. */
export function createSourceReader(request: Request): SourceReader {
  const cache = new Map<string, Promise<unknown>>();
  const read = <T,>(comparison: Comparison, route: string, extra: Record<string, string>) => {
    const params = new URLSearchParams(extra);
    for (const [key, value] of Object.entries({
      version: comparison.version,
      generation: comparison.generation,
      commit: comparison.commit,
      repositoryId: comparison.pins?.repositoryId,
      base: comparison.pins?.base,
      head: comparison.pins?.head,
    }))
      if (value !== undefined) params.set(key, String(value));
    const url = `${API_ORIGIN}${API_PREFIX}/${encodeURIComponent(comparison.reviewId)}${route}?${params}`;
    const key =
      comparison.version === undefined ? undefined : `${comparison.generation ?? ""}:${url}`;
    const cached = key && cache.get(key);
    if (cached) return cached as Promise<T>;
    const promise = readJson<T>(request, url);
    if (key) {
      cache.set(key, promise);
      promise.catch(() => cache.delete(key));
      if (cache.size > 256) cache.delete(cache.keys().next().value!);
    }
    return promise;
  };
  return {
    files: (comparison) => read(comparison, "/diff", { format: "files" }),
    file: (comparison, side, path, projection) =>
      read(comparison, "/file", { side, file: path, ...(projection ? { projection } : {}) }),
  };
}

async function readJson<T>(request: Request, url: string): Promise<T> {
  const response = await request(url);
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new Error(
      typeof body?.error === "string" ? body.error : `Could not read source (${response.status}).`,
    );
  }
  return response.json() as Promise<T>;
}

export interface FileModel {
  livePath?: string;
  patch?: string;
  /** The head line of the first change, where the Diffs view opens the file. */
  firstChangedLine?: number;
  source?: { path: string; content: string };
  old: { path: string; content: string };
  new: { path: string; content: string };
}

export async function loadFileModel(
  reader: SourceReader,
  comparison: Comparison,
  file: ReviewDiffFileWire,
  ranges?: readonly SourceRange[],
  side: ReviewDiffSide = "head",
): Promise<FileModel> {
  const base = resolveSide({ ...file, side: "base" });
  const head = resolveSide({ ...file, side: "head" });
  const [headText, baseText] = await Promise.all([
    head
      ? reader.file(
          comparison,
          "head",
          head.path,
          file.status === "unchanged" ? undefined : "comparison",
        )
      : Promise.resolve({ text: "", localPath: undefined }),
    file.status === "unchanged"
      ? Promise.resolve(null)
      : base
        ? reader.file(comparison, "base", base.path, "comparison")
        : Promise.resolve({ text: "", localPath: undefined }),
  ]);
  const model: FileModel = {
    old: { path: base?.path ?? "/dev/null", content: (baseText ?? headText).text },
    new: { path: head?.path ?? "/dev/null", content: headText.text },
    livePath: headText.localPath,
  };
  const patch = sourcePatch({ file, base: model.old.content, head: model.new.content, ranges });
  model.patch = patch?.text;
  model.firstChangedLine = patch?.firstChangedLine;
  if (model.patch || file.status === "unchanged") return model;
  // A peek outside the comparison hunks renders raw source, including Git
  // filters/line endings. Its navigation is validated against those raw bytes.
  const sourceSide =
    resolveSide({ ...file, side }) ??
    resolveSide({ ...file, side: side === "head" ? "base" : "head" });
  if (!sourceSide) return model;
  const raw = await reader.file(comparison, sourceSide.side, sourceSide.path);
  return {
    ...model,
    source: { path: sourceSide.path, content: raw.text },
    livePath: sourceSide.side === "head" ? raw.localPath : undefined,
  };
}

export function documentScope(
  view: ReviewSourceView | undefined,
  reviewId: string,
  spec: Pick<ReviewInlineEditorSpec, "path" | "side" | "pins" | "ranges">,
): { lens: ReviewDiffLens; comparison: Comparison } {
  const comparison: Comparison = spec.pins
    ? { reviewId: view?.reviewId ?? reviewId, version: view?.version, pins: spec.pins }
    : {
        reviewId: view?.reviewId ?? reviewId,
        version: view?.version,
        generation: view?.generation,
        commit: view?.commit,
        pins: view?.pins,
      };
  return {
    comparison,
    lens: {
      id: "document",
      title: spec.path,
      reviewId: comparison.reviewId,
      version: comparison.version ?? 0,
      ranges: spec.ranges.map((range) => ({
        file: spec.path,
        side: range.side ?? spec.side,
        fromLine: range.startLine,
        toLine: range.endLine,
      })),
    },
  };
}

export async function loadFiles(
  reader: SourceReader,
  comparison: Comparison,
  lens?: ReviewDiffLens,
) {
  const files = comparison.pins && !comparison.pins.base ? [] : await reader.files(comparison);
  return orderDiffFiles(
    lens
      ? lensFiles(files, lens).filter((file) =>
          lens.ranges.some((range) => range.file === sidePath(file, range.side)),
        )
      : files,
  );
}

/** Error subscribers also receive an initialization error that occurred before subscribing. */
export function surfaceErrors() {
  const listeners = new Set<(message: string) => void>();
  let message: string | undefined;
  let disposed = false;
  return {
    fire(error: unknown) {
      if (disposed) return;
      message = error instanceof Error ? error.message : String(error);
      for (const listener of listeners) listener(message);
    },
    subscribe(listener: (message: string) => void): ReviewDisposable {
      if (disposed) return { dispose() {} };
      listeners.add(listener);
      if (message)
        queueMicrotask(() => {
          if (listeners.has(listener)) listener(message!);
        });
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

/** Thin wrappers: bb owns syntax, line presentation, selection and context expansion. */
export function CodeFile({
  file,
  reader,
  comparison,
  ranges,
  side = "head",
  label = file.path,
  progress,
  open,
  onToggleOpen,
  lazyRoot,
  onRevealLoad,
  onToggleViewed,
  openFile,
  onError,
  onHeight,
  heightMode,
}: {
  file: ReviewDiffFileWire;
  reader: SourceReader;
  comparison: Comparison;
  /** A peek's lens ranges. The Diffs view passes none. */
  ranges?: readonly SourceRange[];
  side?: ReviewDiffSide;
  /** The header label, a peek's `path:from-to`. */
  label?: string;
  progress?: ReviewDiffProgressFile;
  /** The Diffs view folds a file to its header. Peeks stay open. */
  open?: boolean;
  onToggleOpen?: () => void;
  /** Load the body once it nears this scroller's viewport. Without one it loads at once. */
  lazyRoot?: HTMLElement;
  /** Set on a reveal's target: it loads at once and calls this when its source lands. */
  onRevealLoad?: () => void;
  onToggleViewed?: () => void;
  openFile?: OpenSourceFile;
  onError(error: unknown): void;
  onHeight?: (height: number) => void;
  heightMode?: ReviewInlineEditorSpec["heightMode"];
}) {
  const [loaded, setLoaded] = useState<{ model?: FileModel; error?: string }>({});
  const [layout, setLayout] = useState(currentDiffLayout);
  const root = useRef<HTMLDivElement>(null);
  const inline = useInlineBreakpoint(root);
  const shown = useShown(root, lazyRoot, open !== false, onRevealLoad !== undefined);
  const revealLoad = useRef(onRevealLoad);
  revealLoad.current = onRevealLoad;
  useEffect(() => {
    const listener = onDidChangeDiffLayout(setLayout);
    return () => listener.dispose();
  }, []);
  useEffect(() => {
    if (!shown) return;
    let current = true;
    setLoaded({});
    loadFileModel(reader, comparison, file, ranges, side).then(
      (model) => {
        if (current) {
          setLoaded({ model });
          revealLoad.current?.();
        }
        return undefined;
      },
      (error: unknown) => {
        if (current) {
          setLoaded({ error: error instanceof Error ? error.message : String(error) });
          onError(error);
        }
        return undefined;
      },
    );
    return () => {
      current = false;
    };
  }, [reader, comparison, file, ranges, side, onError, shown]);
  useReportedHeight(root, onHeight, heightMode, loaded);
  const range = ranges?.find((item) => item.side === side) ?? ranges?.[0];
  // Vendored http.ts `/:id/file` returns `localPath` only for live head bytes of
  // a worktree comparison without commit or pins. `livePath` carries that gate.
  const { canOpen, readOnly } = openability(
    loaded.model,
    side === "base" || range?.side === "base",
    Boolean(openFile),
    file.status === "deleted",
  );
  const line = loaded.model?.firstChangedLine;
  const openInEditor = () => {
    if (!canOpen) return;
    void openFile!({
      reviewId: comparison.reviewId,
      version: comparison.version,
      generation: comparison.generation,
      path: file.path,
      pins: comparison.pins,
      ...(range
        ? { startLine: range.fromLine, endLine: range.toLine }
        : line
          ? { startLine: line, endLine: line }
          : {}),
    }).catch(onError);
  };
  return (
    <div
      ref={root}
      data-wb-path={file.path}
      className="review-files-editor-item flex min-h-0 flex-col border-b border-[var(--rule)]"
    >
      <FileHeader
        file={file}
        label={label}
        peek={ranges !== undefined}
        progress={progress}
        open={open}
        onToggleOpen={onToggleOpen}
        onOpen={canOpen ? openInEditor : undefined}
        readOnly={readOnly}
        onToggleViewed={onToggleViewed}
      />
      {open === false ? null : loaded.error ? (
        <div role="alert" className="px-3 py-2 text-[var(--change-removed)]">
          {loaded.error}
        </div>
      ) : shown ? (
        <CodeContents
          file={file}
          model={loaded.model}
          ranges={ranges}
          side={side}
          view={layout === "split" && inline ? "unified" : layout}
          capped={heightMode === "capped"}
        />
      ) : (
        <div style={{ height: 18 * Math.min(file.additions + file.deletions + 6, 40) }} />
      )}
    </div>
  );
}

/** Monaco's `renderSideBySideInlineBreakpoint`: a split diff renders inline below 900px. */
function useInlineBreakpoint(ref: RefObject<HTMLElement | null>) {
  const [inline, setInline] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      setInline(width > 0 && width < 900);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return inline;
}

/** Whether a body may load: once it is open within 600px of `root` (DocumentCodeView's margin). */
function useShown(
  ref: RefObject<HTMLElement | null>,
  root: HTMLElement | undefined,
  open: boolean,
  force: boolean,
) {
  const [shown, setShown] = useState(root === undefined);
  useLayoutEffect(() => {
    const element = ref.current;
    if (shown || !open || !element) return;
    // jsdom and legacy hosts lack IntersectionObserver; loading eagerly beats never loading.
    if (force || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setShown(true);
      },
      { root, rootMargin: "600px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, root, shown, open, force]);
  return shown;
}

/** Reports the element's document height now and whenever it resizes. */
function useReportedHeight(
  ref: RefObject<HTMLElement | null>,
  onHeight: ((height: number) => void) | undefined,
  heightMode: ReviewInlineEditorSpec["heightMode"] | undefined,
  content: unknown,
) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!onHeight || !element) return;
    const report = () => {
      const height = element.getBoundingClientRect().height || element.scrollHeight;
      if (height > 0) onHeight(documentHeight(height, heightMode ?? "content"));
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, onHeight, heightMode, content]);
}

/**
 * Whether a source opens in File Editor, or why not. Known only once the
 * source loads. A deletion has no file to open.
 */
function openability(
  model: FileModel | undefined,
  baseSide: boolean,
  hasOpener: boolean,
  deleted: boolean,
): { canOpen: boolean; readOnly?: string } {
  if (!hasOpener || !model) return { canOpen: false };
  if (!baseSide && model.livePath) return { canOpen: true };
  if (deleted) return { canOpen: false };
  return {
    canOpen: false,
    readOnly: baseSide ? BASE_SOURCE_NOT_OPENABLE : PINNED_SOURCE_NOT_OPENABLE,
  };
}

const PATH_LABEL = "review-path-label min-w-0 flex-1 truncate text-left [direction:rtl]";

/** Upstream's multi-diff header. Counts and labels come from the file tree's `treeCounts`. */
function FileHeader({
  file,
  label,
  peek,
  progress,
  open,
  onToggleOpen,
  onOpen,
  readOnly,
  onToggleViewed,
}: {
  file: ReviewDiffFileWire;
  label: string;
  peek: boolean;
  progress?: ReviewDiffProgressFile;
  open?: boolean;
  onToggleOpen?: () => void;
  onOpen?: () => void;
  /** Why the loaded source cannot open in File Editor. */
  readOnly?: string;
  onToggleViewed?: () => void;
}) {
  // Peeks count only what their lens progress covers; pinned peeks have none.
  const counts = treeCounts(file, progress, !peek);
  // The path elides from the left, so the file name stays; the title holds all of it.
  const title = onOpen
    ? `${label}\nOpen file in File Editor`
    : readOnly
      ? `${label}\n${readOnly}`
      : label;
  return (
    <div className="review-multidiff-header flex h-9 shrink-0 items-center gap-2 bg-[var(--wb-surface-raised)] px-3 text-xs">
      {onToggleOpen ? (
        <button
          type="button"
          className="-ml-1.5 flex size-6 shrink-0 cursor-pointer items-center justify-center text-[var(--ink-muted)]"
          aria-expanded={open}
          aria-label={`Toggle diff: ${file.path}`}
          onClick={onToggleOpen}
        >
          <Chevron open={open !== false} />
        </button>
      ) : null}
      {onOpen ? (
        <button
          type="button"
          className={`${PATH_LABEL} cursor-pointer`}
          title={title}
          onClick={onOpen}
        >
          <bdi>{label}</bdi>
        </button>
      ) : (
        <span className={PATH_LABEL} title={title}>
          <bdi>{label}</bdi>
        </span>
      )}
      {counts.label === "" ? null : (
        <span
          className={`review-multidiff-counts shrink-0 font-[family-name:var(--wb-font-mono)] tabular-nums ${counts.label ? "text-[var(--ink-muted)]" : ""}`}
          title={counts.tooltip}
        >
          {counts.label ?? (
            <>
              <span className="text-[var(--change-added)]">{counts.added}</span>{" "}
              <span className="text-[var(--change-removed)]">{counts.removed}</span>
            </>
          )}
        </span>
      )}
      {onOpen ? (
        <button
          type="button"
          className="review-multidiff-open shrink-0 cursor-pointer text-[var(--ink-muted)]"
          onClick={onOpen}
        >
          Open file
        </button>
      ) : null}
      {onToggleViewed ? (
        <ViewedButton
          progress={viewedProgress(
            progress ?? {
              state: "unread",
              total: { additions: file.additions, deletions: file.deletions },
              remaining: { additions: file.additions, deletions: file.deletions },
            },
          )}
          label={file.path}
          onClick={onToggleViewed}
        />
      ) : null}
    </div>
  );
}

/** The lens rows' viewed box reads coverage; file and section progress carry the same counts. */
function viewedProgress(
  progress: Pick<ReviewDiffProgressFile, "state" | "total" | "remaining">,
): CoverageProgress {
  return {
    state: progress.state,
    total: progress.total,
    remaining: progress.remaining,
    folded: { additions: 0, deletions: 0 },
  };
}

function CodeContents({
  file,
  model,
  ranges,
  side,
  view,
  capped,
}: {
  file: ReviewDiffFileWire;
  model?: FileModel;
  ranges?: readonly SourceRange[];
  side: ReviewDiffSide;
  view: "unified" | "split";
  /** A capped peek gives the code its one scroller below a fixed header. */
  capped: boolean;
}) {
  if (!model) return <output className="block px-3 py-2">Loading source…</output>;
  let source = model.source ?? (side === "base" ? model.old : model.new);
  if (source.path === "/dev/null") source = side === "base" ? model.new : model.old;
  const sideRanges = ranges?.filter((item) => item.side === side);
  // A peek outside every hunk shows its ranges ±3 lines of source; bb folds the rest.
  const context =
    !model.patch && ranges?.length
      ? contextPatch({
          path: source.path,
          content: source.content,
          ranges: sideRanges?.length ? sideRanges : ranges,
        })
      : undefined;
  const props = model.patch
    ? {
        patch: model.patch,
        path: file.path,
        view,
        experimental_fullFileContents: { old: model.old, new: model.new },
      }
    : context && {
        patch: context,
        path: source.path,
        view: "unified" as const,
        experimental_fullFileContents: { old: source, new: source },
      };
  if (!props)
    return (
      <SourceCode
        content={source.content}
        path={source.path}
        className={capped ? "min-h-0 flex-1" : "max-h-[400px]"}
      />
    );
  return capped ? (
    <div className="min-h-0 flex-1 overflow-auto">
      <Diff {...props} />
    </div>
  ) : (
    <Diff {...props} />
  );
}

export function documentHeight(content: number, heightMode: ReviewInlineEditorSpec["heightMode"]) {
  const height = Math.max(40, Math.ceil(content));
  return heightMode === "capped" ? Math.min(400, height) : height;
}

/**
 * Which Diffs view files are open, upstream's GitHub shape (`reviewFilesDiffView.ts`):
 * a viewed or folded file starts closed, a file closes when it is marked viewed and
 * reopens when it is unmarked. A reveal opens its file. Keys are `${sectionId}:${path}`.
 */
function fileFolds() {
  const folds = new Map<string, { path: string; state?: ReviewDiffProgressState; open: boolean }>();
  return {
    /** Records `state`. Idempotent for an unchanged state, so a render may call it. */
    isOpen(
      key: string,
      path: string,
      state: ReviewDiffProgressState | undefined,
      revealed: boolean,
    ) {
      const fold = folds.get(key);
      const done = state === "viewed" || state === "folded";
      let open: boolean;
      if (!fold) open = revealed || !done;
      else if (fold.state === undefined) open = fold.open && !done;
      else if (fold.state !== "viewed" && state === "viewed") open = false;
      else if (fold.state === "viewed" && state !== "viewed") open = true;
      else open = fold.open;
      folds.set(key, { path, state, open });
      return open;
    },
    toggle(key: string) {
      const fold = folds.get(key);
      if (fold) fold.open = !fold.open;
    },
    reveal(path: string) {
      for (const fold of folds.values()) if (fold.path === path) fold.open = true;
    },
  };
}

type FileFolds = ReturnType<typeof fileFolds>;

export function createDiffView(deps: CodeSurfaceDeps): ReviewDiffViewFactory {
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
    files: (scope) => reader.files(comparison(scope)),
    create(spec) {
      const errors = surfaceErrors();
      const id = `diff:${crypto.randomUUID()}`;
      let disposed = false;
      let files: ReviewDiffFileWire[] = [];
      let progress = spec.progress;
      // A request, not a state: revealing the active file again scrolls again.
      let reveal: Reveal | undefined;
      const folds = fileFolds();
      let current: Comparison;
      try {
        current = lensComparison(comparison(spec.scope), spec);
      } catch (error) {
        errors.fire(error);
        return { focus() {}, onDidError: errors.subscribe, dispose: errors.dispose };
      }
      const onError = errors.fire;
      const scroll = new Set<(viewport: { height: number }) => void>();
      const revealFile = (path: string) => {
        reveal = { path, seq: (reveal?.seq ?? 0) + 1 };
        folds.reveal(path);
        render();
      };
      const toggleOpen = (key: string) => {
        folds.toggle(key);
        render();
      };
      const fileElement = (path: string) =>
        Array.from(spec.container.querySelectorAll<HTMLElement>("[data-wb-path]")).find(
          (element) => element.dataset.wbPath === path,
        );
      const render = () => {
        if (disposed) return;
        deps.portals.update(
          id,
          <DiffList
            files={files}
            spec={spec}
            progress={progress}
            reader={reader}
            comparison={current}
            openFile={deps.openFile}
            onError={onError}
            reveal={reveal}
            folds={folds}
            onToggleOpen={toggleOpen}
          />,
        );
        if (spec.fileTreeContainer)
          deps.portals.update(
            `${id}:tree`,
            <DiffFileTree
              files={files}
              progress={progress}
              showFileCounts
              activePath={reveal?.path}
              onReveal={revealFile}
              onToggleViewed={
                spec.onToggleViewed ? (path) => spec.onToggleViewed?.(path) : undefined
              }
            />,
          );
      };
      const unmount = deps.portals.mount({
        id,
        container: spec.container,
        element: <output>Loading diffs…</output>,
      });
      const unmountTree = spec.fileTreeContainer
        ? deps.portals.mount({ id: `${id}:tree`, container: spec.fileTreeContainer, element: null })
        : undefined;
      const onScroll = () => {
        for (const listener of scroll) listener({ height: spec.container.clientHeight });
      };
      spec.container.addEventListener("scroll", onScroll);
      void loadFiles(reader, current, spec.lens).then((loaded) => {
        if (!disposed) {
          files = loaded;
          render();
        }
        return undefined;
      }, onError);
      return {
        focus: () => spec.container.focus(),
        setProgress(value) {
          progress = value;
          render();
        },
        revealFile,
        revealSource(source) {
          revealFile(
            files.find((file) => source.file === sidePath(file, source.side))?.path ?? source.file,
          );
        },
        sourceOffset(source) {
          const element = fileElement(
            files.find((file) => source.file === sidePath(file, source.side))?.path ?? source.file,
          );
          return element
            ? element.getBoundingClientRect().top - spec.container.getBoundingClientRect().top
            : undefined;
        },
        onDidScroll(listener) {
          scroll.add(listener);
          return {
            dispose: () => {
              scroll.delete(listener);
            },
          };
        },
        onDidError: errors.subscribe,
        dispose() {
          disposed = true;
          errors.dispose();
          scroll.clear();
          spec.container.removeEventListener("scroll", onScroll);
          unmount();
          unmountTree?.();
        },
      } satisfies ReviewDiffViewHandle;
    },
  };
}

/** A lens reads its own immutable version of the session's comparison. */
function lensComparison(current: Comparison, spec: ReviewDiffViewSpec): Comparison {
  if (!spec.lens) return current;
  if (spec.scope || spec.lens.reviewId !== current.reviewId)
    throw new Error("A lens must use its review comparison.");
  return {
    ...current,
    version: spec.lens.version,
    generation: spec.lens.version === current.version ? current.generation : undefined,
  };
}

interface Reveal {
  path: string;
  seq: number;
}

function DiffList({
  files,
  spec,
  progress,
  reader,
  comparison,
  openFile,
  onError,
  reveal,
  folds,
  onToggleOpen,
}: {
  files: readonly ReviewDiffFileWire[];
  spec: ReviewDiffViewSpec;
  progress?: ReviewDiffProgress;
  reader: SourceReader;
  comparison: Comparison;
  openFile?: OpenSourceFile;
  onError(error: unknown): void;
  reveal?: Reveal;
  folds: FileFolds;
  onToggleOpen(key: string): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [revealLoads, setRevealLoads] = useState(0);
  const onRevealLoad = useCallback(() => setRevealLoads((count) => count + 1), []);
  // The one reveal scroller: a new request, late files, or the target's source landing.
  useLayoutEffect(() => {
    if (!reveal) return;
    Array.from(root.current?.querySelectorAll<HTMLElement>("[data-wb-path]") ?? [])
      .find((element) => element.dataset.wbPath === reveal.path)
      ?.scrollIntoView?.({ block: "start" });
  }, [reveal, files, revealLoads]);
  const document = spec.document;
  const onDocumentHeight = useCallback(
    (height: number) => document?.onDidChangeHeight(height),
    [document],
  );
  useReportedHeight(root, document ? onDocumentHeight : undefined, document?.heightMode, files);
  const renderFile = (file: ReviewDiffFileWire, sectionId?: string) => {
    const key = `${sectionId ?? ""}:${file.path}`;
    const fileProgress = (
      sectionId
        ? progress?.sections?.find((section) => section.id === sectionId)?.files
        : progress?.files
    )?.find((item) => item.path === file.path);
    const revealed = reveal?.path === file.path;
    return (
      <CodeFile
        key={key}
        file={file}
        reader={reader}
        comparison={comparison}
        progress={fileProgress}
        open={folds.isOpen(key, file.path, fileProgress?.state, revealed)}
        onToggleOpen={() => onToggleOpen(key)}
        lazyRoot={spec.container}
        onRevealLoad={revealed ? onRevealLoad : undefined}
        openFile={openFile}
        onError={onError}
        onToggleViewed={
          spec.onToggleViewed ? () => spec.onToggleViewed?.(file.path, sectionId) : undefined
        }
      />
    );
  };
  return (
    <div
      ref={root}
      className="review-files-editor min-h-0"
      tabIndex={-1}
      onFocus={spec.document?.onDidFocus}
    >
      {spec.lens && progress?.sections?.length
        ? progress.sections.map((section) => (
            <section key={section.id}>
              <div className="review-diff-group flex items-center gap-2 border-b border-[var(--rule)] px-3 py-2">
                <span className="min-w-0 flex-1">{section.label}</span>
                <span>
                  +{section.remaining.additions} −{section.remaining.deletions}
                </span>
                {spec.onToggleSection ? (
                  <ViewedButton
                    progress={viewedProgress(section)}
                    label={section.label}
                    onClick={() => spec.onToggleSection?.(section.id)}
                  />
                ) : null}
              </div>
              {files
                .filter((file) => lensRangesFor(section.sources, file).length > 0)
                .map((file) => renderFile(file, section.id))}
            </section>
          ))
        : files.map((file) => renderFile(file))}
      {!files.length ? (
        <p className="px-3 py-2 text-[var(--ink-muted)]">No changed files.</p>
      ) : null}
    </div>
  );
}
