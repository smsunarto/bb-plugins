import {
  experimental_Diff as Diff,
  experimental_SourceCode as SourceCode,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { API_ORIGIN, API_PREFIX } from "../../shared/contracts/api-tunnel.ts";
import type {
  ReviewCommitScope,
  ReviewDiffFileWire,
  ReviewDiffLens,
  ReviewDiffProgress,
  ReviewDiffProgressFile,
  ReviewDiffSide,
  ReviewDiffViewFactory,
  ReviewDiffViewHandle,
  ReviewDiffViewSpec,
  ReviewDisposable,
  ReviewInlineEditorSpec,
  ReviewSourcePins,
  ReviewSourceView,
} from "../../shared/vendor/review-protocol/src/index.ts";
import { DiffFileTree } from "./diff-file-tree.tsx";
import type { Portals } from "./portals.tsx";
import { currentDiffLayout, onDidChangeDiffLayout } from "./theme.ts";
import {
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
  model.patch = sourcePatch({ file, base: model.old.content, head: model.new.content, ranges });
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
  progress,
  onToggleViewed,
  openFile,
  onError,
  onHeight,
  heightMode,
}: {
  file: ReviewDiffFileWire;
  reader: SourceReader;
  comparison: Comparison;
  ranges?: readonly SourceRange[];
  side?: ReviewDiffSide;
  progress?: ReviewDiffProgressFile;
  onToggleViewed?: () => void;
  openFile?: OpenSourceFile;
  onError(error: unknown): void;
  onHeight?: (height: number) => void;
  heightMode?: ReviewInlineEditorSpec["heightMode"];
}) {
  const [loaded, setLoaded] = useState<{ model?: FileModel; error?: string }>({});
  const [layout, setLayout] = useState(currentDiffLayout);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const listener = onDidChangeDiffLayout(setLayout);
    return () => listener.dispose();
  }, []);
  useEffect(() => {
    let current = true;
    setLoaded({});
    loadFileModel(reader, comparison, file, ranges, side).then(
      (model) => {
        if (current) setLoaded({ model });
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
  }, [reader, comparison, file, ranges, side, onError]);
  useLayoutEffect(() => {
    if (!onHeight || !root.current) return;
    const element = root.current;
    const report = () => {
      const height = element.getBoundingClientRect().height || element.scrollHeight;
      if (height > 0) onHeight(documentHeight(height, heightMode ?? "content"));
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [loaded, heightMode, onHeight]);
  const range = ranges?.find((item) => item.side === side) ?? ranges?.[0];
  const canOpen = Boolean(
    side === "head" &&
    range?.side !== "base" &&
    openFile &&
    loaded.model?.livePath &&
    (comparison.version === undefined || comparison.generation !== undefined) &&
    !comparison.commit &&
    !comparison.pins,
  );
  const open = () => {
    if (!canOpen) return;
    void openFile!({
      reviewId: comparison.reviewId,
      version: comparison.version,
      generation: comparison.generation,
      path: file.path,
      pins: comparison.pins,
      ...(range ? { startLine: range.fromLine, endLine: range.toLine } : {}),
    }).catch(onError);
  };
  return (
    <div
      ref={root}
      data-wb-path={file.path}
      className="review-files-editor-item border-b border-[var(--rule)]"
    >
      <FileHeader
        file={file}
        progress={progress}
        onOpen={canOpen ? open : undefined}
        onToggleViewed={onToggleViewed}
      />
      {loaded.error ? (
        <div role="alert" className="px-3 py-2 text-[var(--change-removed)]">
          {loaded.error}
        </div>
      ) : (
        <CodeContents
          file={file}
          model={loaded.model}
          ranges={ranges}
          side={side}
          layout={layout}
        />
      )}
    </div>
  );
}

function FileHeader({
  file,
  progress,
  onOpen,
  onToggleViewed,
}: {
  file: ReviewDiffFileWire;
  progress?: ReviewDiffProgressFile;
  onOpen?: () => void;
  onToggleViewed?: () => void;
}) {
  return (
    <div className="review-multidiff-header flex h-9 items-center gap-2 bg-[var(--wb-surface-raised)] px-3 text-xs">
      {onOpen ? (
        <button
          type="button"
          className="review-path-label min-w-0 flex-1 cursor-pointer truncate text-left"
          title="Open file in File Editor"
          onClick={onOpen}
        >
          {file.path}
        </button>
      ) : (
        <span className="review-path-label min-w-0 flex-1 truncate">{file.path}</span>
      )}
      <span className="font-[family-name:var(--wb-font-mono)] tabular-nums">
        {progress?.state === "viewed" ? (
          "Viewed"
        ) : progress?.state === "folded" ? (
          "Folded"
        ) : (
          <>
            <span className="text-[var(--change-added)]">
              +{progress?.remaining.additions ?? file.additions}
            </span>{" "}
            <span className="text-[var(--change-removed)]">
              −{progress?.remaining.deletions ?? file.deletions}
            </span>
          </>
        )}
      </span>
      {onOpen ? (
        <button
          type="button"
          className="review-multidiff-open cursor-pointer text-[var(--ink-muted)]"
          onClick={onOpen}
        >
          Open file
        </button>
      ) : (
        <span className="text-[var(--ink-faint)]">Read only</span>
      )}
      {onToggleViewed ? (
        <ViewedCheck state={progress?.state} label={file.path} onToggle={onToggleViewed} />
      ) : null}
    </div>
  );
}

function CodeContents({
  file,
  model,
  ranges,
  side,
  layout,
}: {
  file: ReviewDiffFileWire;
  model?: FileModel;
  ranges?: readonly SourceRange[];
  side: ReviewDiffSide;
  layout: "unified" | "split";
}) {
  if (!model) return <output className="block px-3 py-2">Loading source…</output>;
  if (model.patch)
    return (
      <Diff
        patch={model.patch}
        path={file.path}
        view={layout}
        experimental_fullFileContents={{ old: model.old, new: model.new }}
      />
    );
  let source = model.source ?? (side === "base" ? model.old : model.new);
  if (source.path === "/dev/null") source = side === "base" ? model.new : model.old;
  const range = ranges?.find((item) => item.side === side) ?? ranges?.[0];
  return (
    <SourceCode
      content={source.content}
      path={source.path}
      highlightedLines={range ? { start: range.fromLine, end: range.toLine } : null}
      className="max-h-[400px]"
    />
  );
}

export function ViewedCheck({
  state,
  label,
  onToggle,
}: {
  state?: ReviewDiffProgressFile["state"];
  label: string;
  onToggle(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = state === "partial";
  }, [state]);
  return (
    <input
      ref={input}
      type="checkbox"
      className="review-viewed-check cursor-pointer accent-[var(--wb-accent)]"
      checked={state === "viewed"}
      aria-label={`${state === "viewed" ? "Mark unviewed" : "Mark viewed"}: ${label}`}
      onChange={onToggle}
    />
  );
}

export function documentHeight(content: number, heightMode: ReviewInlineEditorSpec["heightMode"]) {
  const height = Math.max(40, Math.ceil(content));
  return heightMode === "capped" ? Math.min(400, height) : height;
}

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
      let activePath: string | undefined;
      let current: Comparison;
      try {
        current = comparison(spec.scope);
        if (spec.lens && (spec.scope || spec.lens.reviewId !== current.reviewId))
          throw new Error("A lens must use its review comparison.");
        if (spec.lens)
          current = {
            ...current,
            version: spec.lens.version,
            generation: spec.lens.version === current.version ? current.generation : undefined,
          };
      } catch (error) {
        errors.fire(error);
        return { focus() {}, onDidError: errors.subscribe, dispose: errors.dispose };
      }
      const onError = errors.fire;
      const scroll = new Set<(viewport: { height: number }) => void>();
      const revealFile = (path: string) => {
        activePath = path;
        render();
        queueMicrotask(() => fileElement(path)?.scrollIntoView?.({ block: "start" }));
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
            activePath={activePath}
          />,
        );
        if (spec.fileTreeContainer)
          deps.portals.update(
            `${id}:tree`,
            <DiffFileTree
              files={files}
              progress={progress}
              showFileCounts
              activePath={activePath}
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
          if (activePath) revealFile(activePath);
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

function DiffList({
  files,
  spec,
  progress,
  reader,
  comparison,
  openFile,
  onError,
  activePath,
}: {
  files: readonly ReviewDiffFileWire[];
  spec: ReviewDiffViewSpec;
  progress?: ReviewDiffProgress;
  reader: SourceReader;
  comparison: Comparison;
  openFile?: OpenSourceFile;
  onError(error: unknown): void;
  activePath?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!activePath) return;
    Array.from(root.current?.querySelectorAll<HTMLElement>("[data-wb-path]") ?? [])
      .find((element) => element.dataset.wbPath === activePath)
      ?.scrollIntoView?.({ block: "start" });
  }, [activePath, files]);
  useLayoutEffect(() => {
    const document = spec.document;
    const element = root.current;
    if (!document || !element) return;
    const report = () => {
      const height = element.getBoundingClientRect().height || element.scrollHeight;
      if (height > 0) document.onDidChangeHeight(documentHeight(height, document.heightMode));
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [spec.document, files]);
  const renderFile = (file: ReviewDiffFileWire, sectionId?: string) => (
    <CodeFile
      key={`${sectionId ?? ""}:${file.path}`}
      file={file}
      reader={reader}
      comparison={comparison}
      progress={(sectionId
        ? progress?.sections?.find((section) => section.id === sectionId)?.files
        : progress?.files
      )?.find((item) => item.path === file.path)}
      openFile={openFile}
      onError={onError}
      onToggleViewed={
        spec.onToggleViewed ? () => spec.onToggleViewed?.(file.path, sectionId) : undefined
      }
    />
  );
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
                  <ViewedCheck
                    state={section.state}
                    label={section.label}
                    onToggle={() => spec.onToggleSection?.(section.id)}
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
