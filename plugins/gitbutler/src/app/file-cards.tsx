import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import {
  experimental_Icon as Icon,
  experimental_useCodeTheme as useCodeTheme,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalFileOpenOptions } from "@get-bb/plugin-sdk/app";
import { getSingularPatch } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { keepPreviousData } from "@tanstack/react-query";
import type { ChangeKind, FilePatch, PatchSource, Workspace } from "../shared/schema.ts";
import { AskAgentButton } from "./ask-agent.tsx";
import { CONTROL_HOVER_TRANSITION } from "./components/ui/motion.ts";
import { CopyButton } from "./copy-button.tsx";
import { ChangedFilesCard, FileList, LineStats, fileOrder, useListMode } from "./file-list.tsx";
import { shortId } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { FileRowsSkeleton, Notice, errorText } from "./notice.tsx";
import { COMMIT_QUERY, REFRESH_INTERVAL_MS } from "./query-client.ts";
import { rpc } from "./rpc.ts";

/** Room left above a file scrolled to, so its card's top edge stays in view. */
const SCROLL_MARGIN_PX = 8;
/** How long the opened file is held in place while the diffs above it render. */
const PIN_MS = 2_000;

type Parsed = ReturnType<typeof getSingularPatch>;

/**
 * Pierre's worker pool keeps a highlighted diff under its `cacheKey`, and a
 * diff whose text changed needs a new one. The key is the patch text itself,
 * not a hash of it: a hash can collide, and then the same path in another
 * commit, or in the worktree after an edit, would draw the old highlight.
 * The pool keeps at most a hundred diffs and already holds their text, so a
 * text key at most doubles what it keeps.
 */
const cacheKeyOf = (patch: string) => `gitbutler:${patch}`;

export function parsePatch(patch: string): Parsed | null {
  if (patch === "") return null;
  try {
    return { ...getSingularPatch(patch), cacheKey: cacheKeyOf(patch) };
  } catch {
    return null;
  }
}

function countLines(parsed: Parsed | null): { added: number; removed: number } {
  if (!parsed) return { added: 0, removed: 0 };
  return {
    added: parsed.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
    removed: parsed.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
  };
}

/**
 * The first line the diff changes, numbered as the file reads after it, so
 * the preview opens on the change and not at the top. Null with no hunks.
 */
export function firstChangedLine(parsed: Parsed | null): number | null {
  const hunk = parsed?.hunks[0];
  if (!hunk) return null;
  let line = hunk.additionStart;
  for (const content of hunk.hunkContent) {
    if (content.type === "change") break;
    line += content.lines;
  }
  // A hunk that empties the file starts at line 0.
  return Math.max(1, line);
}

/** What bb's file preview needs from the workspace answer to find a file. */
export type FileWorkspace = Pick<Workspace, "environmentId" | "repositoryKey">;

/** Opens a repository file in bb's preview, at `line` when there is one. */
export type OpenFile = (path: string, line: number | null) => void;

/**
 * The preview request for a file of this repository. bb names a workspace file
 * by its path from the environment root, and the repository key is the
 * repository's folder under that root, "." for the root itself. Null until
 * the panel knows which environment and repository it read.
 */
export function filePreview(
  workspace: FileWorkspace | undefined,
): ((path: string, line: number | null) => ExperimentalFileOpenOptions) | null {
  const environmentId = workspace?.environmentId;
  const repositoryKey = workspace?.repositoryKey;
  if (!environmentId || !repositoryKey) return null;
  return (path, line) => ({
    target: {
      kind: "workspace",
      environmentId,
      path: repositoryKey === "." ? path : `${repositoryKey}/${path}`,
    },
    location: line === null ? null : { kind: "line", line, column: null },
  });
}

/** Opens files in bb's preview. Null when there is no preview to open them in. */
export function useOpenFile(workspace: FileWorkspace | undefined): OpenFile | null {
  const navigate = useBbNavigate();
  const preview = filePreview(workspace);
  // bb hosts from before the preview have no such method.
  if (!preview || typeof navigate.experimental_openFilePreview !== "function") return null;
  return (path, line) => {
    navigate.experimental_openFilePreview(preview(path, line));
  };
}

const ICON_BUTTON = cn(
  "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground",
  CONTROL_HOVER_TRANSITION,
);

/**
 * bb's diff panel draws its own file header in the light DOM, and this panel
 * renders inside the same secondary-panel shelf. Reproducing that markup, down
 * to the `model` prop `plugins/monokai` reads off the fiber, means monokai's
 * header rules and its injected change icon apply here verbatim. Matching it
 * by eye against Pierre's shadow-root header never converged.
 */
function FileHeader({
  model,
  open,
  counts,
  truncated,
  bodyId,
  onToggle,
  quote,
  openFile,
}: {
  model: { path: string; label: string; changeKind: ChangeKind };
  open: boolean;
  /** Null when there is no patch text to count. */
  counts: { added: number; removed: number } | null;
  truncated: boolean;
  bodyId: string;
  onToggle: () => void;
  /** What Ask agent quotes: the path and where the change is. */
  quote: string;
  /** Null when there is no preview, or no file left to open. */
  openFile: Opener | null;
}) {
  return (
    // Sticky like bb's: monokai paints a sticky diff header with its opaque
    // fallback and a static one with a 6% layer, so this is what picks the same
    // fill. It also keeps the path in view while the diff scrolls.
    <div className="sticky top-0 z-10 rounded-lg bg-background px-3 py-0 text-xs font-medium text-foreground">
      <div className="flex min-h-10 w-full min-w-0 items-center justify-between gap-2">
        <span className="flex min-w-0 flex-1 items-center">
          <button
            type="button"
            className="inline-flex w-8 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`${open ? "Collapse" : "Expand"} ${model.path}`}
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={onToggle}
          >
            <Icon
              name="ChevronRight"
              className={cn(
                "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
              )}
              aria-hidden
            />
          </button>
          {/* monokai's content script prepends the change icon into this span. */}
          <span className="flex min-w-0 flex-1 items-center gap-1.5 pl-[1ch]">
            {/* bb makes the filename a button that opens the file. Here it
                toggles the row, which gives the disclosure a target worth
                aiming at, and Open sits beside Copy instead. */}
            <button
              type="button"
              className="inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left font-mono text-xs font-medium leading-5 text-foreground underline-offset-2 hover:underline"
              title={model.path}
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={onToggle}
            >
              {/* `dir=rtl` keeps the tail of a long path visible, as bb does.
                  The LRM stops a leading dot from being reordered. */}
              <span dir="rtl" className="block w-full truncate">
                {`\u200e${model.path}`}
              </span>
            </button>
            <CopyButton value={model.path} label={`Copy path for ${model.path}`} />
            {openFile ? (
              <button
                type="button"
                aria-label={openFile.label}
                title={openFile.label}
                className={ICON_BUTTON}
                onClick={openFile.run}
              >
                <Icon name="ArrowUpRight" className="size-3" aria-hidden />
              </button>
            ) : null}
            <AskAgentButton text={quote} label={`Ask agent about ${model.path}`} />
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <span className="whitespace-nowrap text-xs tabular-nums">
            {counts ? (
              <>
                <span className="text-diff-added">+{counts.added}</span>{" "}
                <span className="text-diff-removed">-{counts.removed}</span>
              </>
            ) : (
              /* Every other row ends in a count pair. A bare change letter in
                 that slot read as a count, so say plainly there is none. */
              <span className="text-muted-foreground">{truncated ? "Too large" : "No diff"}</span>
            )}
          </span>
        </span>
      </div>
    </div>
  );
}

/** What Ask agent quotes: the file, and which version of it the card shows. */
function fileQuote(path: string, commit: string | null): string {
  return commit ? `${path} in commit ${commit}` : `${path} (uncommitted)`;
}

type Opener = { label: string; run: () => void };

/**
 * The preview reads the worktree, so a commit's file opens as it is now, at
 * its top: the commit's line numbers are off by whatever changed the file
 * since. A deleted file has nothing to open, and neither does an upstream
 * commit's, which is not in the worktree until it is pulled.
 */
function fileOpener(
  file: FilePatch,
  parsed: Parsed | null,
  source: PatchSource,
  openFile: OpenFile | null,
): Opener | null {
  if (!openFile || file.kind === "deleted") return null;
  if (source.kind === "uncommitted") {
    return { label: `Open ${file.path}`, run: () => openFile(file.path, firstChangedLine(parsed)) };
  }
  if (source.where === "upstream") return null;
  return { label: `Open current version of ${file.path}`, run: () => openFile(file.path, null) };
}

/** A diff too large to show, cut short or left out, and where to read it instead. */
function TooLarge({
  partial,
  opener,
  commit,
}: {
  partial: boolean;
  opener: Opener | null;
  commit: boolean;
}) {
  const lead = partial
    ? "This diff is too large to show in full."
    : "This diff is too large to show.";
  const rest = partial ? "the rest" : "it";
  if (!opener) return `${lead} Open the file in your editor to read ${rest}.`;
  return (
    <>
      {`${lead} `}
      <button
        type="button"
        className="cursor-pointer underline underline-offset-2"
        onClick={opener.run}
      >
        {commit ? "Open the current file" : "Open the file"}
      </button>
      {` to read ${rest}.`}
    </>
  );
}

/**
 * One file: bb's own header, always drawn, and Pierre's diff body below it once
 * the row is open.
 */
function FileCard({
  file,
  source,
  openFile,
}: {
  file: FilePatch;
  source: PatchSource;
  openFile: OpenFile | null;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const onToggle = () => setOpen((current) => !current);
  const { mode, name } = useCodeTheme();
  const parsed = useMemo(() => parsePatch(file.patch), [file.patch]);
  const counts = useMemo(() => (parsed ? countLines(parsed) : null), [parsed]);
  const model = useMemo(
    () => ({ path: file.path, label: file.path, changeKind: file.kind }),
    [file.kind, file.path],
  );
  const commit = source.kind === "commit" ? shortId(source.commitId) : null;
  const quote = fileQuote(file.path, commit);
  const opener = fileOpener(file, parsed, source, openFile);

  const bodyOptions = useMemo(
    () => ({
      collapsed: false,
      disableFileHeader: true,
      // A thread panel is a column, not a page. Split view halves an already
      // narrow column, so the panel always reads unified.
      diffStyle: "unified" as const,
      stickyHeader: false,
      theme: name,
      themeType: mode,
    }),
    [mode, name],
  );

  return (
    // Clipped, not hidden: a hidden overflow would make this card the sticky
    // header's scroll container, and the header would scroll away with the diff.
    <div
      className="overflow-clip rounded-lg border border-border bg-card"
      data-file-card={file.path}
    >
      <FileHeader
        model={model}
        open={open}
        counts={counts}
        truncated={file.truncated}
        bodyId={bodyId}
        onToggle={onToggle}
        quote={quote}
        openFile={opener}
      />
      <div id={bodyId} hidden={!open}>
        {open ? (
          parsed ? (
            <div className="gb-diff border-t border-border">
              {/* One phrasing for one condition, here and in the branch below. */}
              {file.truncated ? (
                <p className="border-b border-border px-2 py-1 text-[11px] text-warning-text">
                  <TooLarge partial opener={opener} commit={commit !== null} />
                </p>
              ) : null}
              <FileDiff fileDiff={parsed} options={bodyOptions} />
            </div>
          ) : (
            <p className="border-t border-border px-2.5 py-1.5 text-[11px] leading-normal text-muted-foreground">
              {file.truncated ? (
                <TooLarge partial={false} opener={opener} commit={commit !== null} />
              ) : file.kind === "renamed" && file.previousPath ? (
                `Renamed from ${file.previousPath}.`
              ) : (
                "No text to show. The file is binary or its contents did not change."
              )}
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}

// A commit's diff is fixed by its id. The worktree's is not, so that one
// is refreshed on the panel's usual cadence.
const WORKTREE_PATCHES = { staleTime: REFRESH_INTERVAL_MS } as const;

/** Long enough that a pointer sweeping down the list does not fetch every row it crosses. */
const INTENT_DELAY_MS = 75;

/**
 * Handlers that start a diff loading when the reader points at, or tabs to,
 * the control that opens it. The diff is usually in by the time they click,
 * so the row opens on its files instead of a placeholder.
 */
export function usePatchesIntent(
  threadId: string,
  repositoryKey: string | undefined,
  source: PatchSource,
) {
  const client = rpc.useClient();
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const start = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const input = { threadId, repositoryKey, source };
      void pluginQueryClient.prefetchQuery({
        queryKey: rpc.patches.queryKey(input),
        queryFn: () => client.patches(input),
        ...(source.kind === "commit" ? COMMIT_QUERY : WORKTREE_PATCHES),
      });
    }, INTENT_DELAY_MS);
  };
  const stop = () => window.clearTimeout(timer.current);
  return { onPointerEnter: start, onPointerLeave: stop, onFocus: start, onBlur: stop };
}

/**
 * One `but diff` call for a commit or the worktree, with the file list and line
 * totals derived from it. Keyed off the query result, not a fresh `?? []`, so
 * the derivations run once per fetch rather than once per render.
 *
 * `keepPrevious` holds a commit's last diff on screen while a rewrite of the
 * same change loads, for a caller whose view stays on that change. `paths`
 * narrows the answer to those files after the fact, so the query, and its
 * cache, stay the whole set's.
 */
export function usePatches(
  threadId: string,
  repositoryKey: string | undefined,
  source: PatchSource,
  options: { keepPrevious?: boolean; paths?: readonly string[] } = {},
) {
  const { keepPrevious = false, paths } = options;
  const patches = rpc.patches.useQuery(
    { threadId, repositoryKey, source },
    source.kind === "commit"
      ? { ...COMMIT_QUERY, placeholderData: keepPrevious ? keepPreviousData : undefined }
      : { ...WORKTREE_PATCHES, refetchInterval: REFRESH_INTERVAL_MS },
  );
  const all = patches.data?.files;
  const files = useMemo(() => {
    if (!all || !paths) return all;
    const wanted = new Set(paths);
    return all.filter((file) => wanted.has(file.path));
  }, [all, paths]);
  const changes = useMemo(
    () => (files ?? []).map((file) => ({ path: file.path, kind: file.kind })),
    [files],
  );
  const totals = useMemo(
    () =>
      (files ?? []).reduce(
        (total, file) => {
          const { added, removed } = countLines(parsePatch(file.patch));
          return { added: total.added + added, removed: total.removed + removed };
        },
        { added: 0, removed: 0 },
      ),
    [files],
  );
  // Past the host's budget, or `but`'s own size limit, some files arrive
  // without patch text, so the totals would undercount. Callers drop them
  // rather than show a part. Read off the files shown, not the whole answer,
  // so a cut file outside `paths` does not hide the totals of the rest.
  const truncated = files?.some((file) => file.truncated) ?? false;
  return { patches, files, changes, totals, truncated };
}

/**
 * Brings `element` to the top of the panel's own scroll area. Not
 * `scrollIntoView`: that also scrolls every clipped ancestor, bb's layout
 * included, and can shift the app around the panel.
 */
function scrollIntoPanel(element: HTMLElement): void {
  const scroller = element.closest<HTMLElement>("[data-scroll-area]");
  if (!scroller) return;
  const offset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop += offset - SCROLL_MARGIN_PX;
}

/**
 * Every file of a commit or of the worktree: the changed-files list, then
 * every file's diff, scrolled to the one the reader opened. A row in the list
 * scrolls to its diff. One `but diff` call covers the whole set.
 */
export function FileCards({
  threadId,
  repositoryKey,
  source,
  initialPath,
  paths,
  workspace,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  source: PatchSource;
  initialPath: string | null;
  /** Only these files, as for the changes assigned to one branch. */
  paths?: readonly string[];
  /** The board's answer, which says where the files live for bb's preview. */
  workspace: FileWorkspace | undefined;
}) {
  const [listOpen, setListOpen] = useState(true);
  const [mode] = useListMode();
  const [active, setActive] = useState(initialPath);
  const section = useRef<HTMLElement>(null);
  const openFile = useOpenFile(workspace);
  const { patches, files, changes, totals, truncated } = usePatches(
    threadId,
    repositoryKey,
    source,
    { paths },
  );

  const scrollTo = useCallback((path: string) => {
    const card = [
      ...(section.current?.querySelectorAll<HTMLElement>("[data-file-card]") ?? []),
    ].find((element) => element.dataset.fileCard === path);
    if (card) scrollIntoPanel(card);
  }, []);

  // Once, when the diffs first land: jump to the file the screen opened on.
  // Keyed on their arrival, not on each refetch of the worktree's diffs.
  const ready = Boolean(files);
  useLayoutEffect(() => {
    const element = section.current;
    if (!ready || !element || !initialPath) return;
    const pin = () => scrollTo(initialPath);
    pin();
    /*
     * Pierre fills each diff in after it mounts, so the page grows under the
     * jump, and at first it is too short to reach the file at all. Hold the
     * file in place as it grows, until it settles or the reader scrolls.
     */
    const scroller = element.closest("[data-scroll-area]");
    const observer = new ResizeObserver(pin);
    observer.observe(element);
    const intents = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      for (const intent of intents) scroller?.removeEventListener(intent, stop);
    };
    const timer = window.setTimeout(stop, PIN_MS);
    for (const intent of intents) scroller?.addEventListener(intent, stop, { passive: true });
    return stop;
  }, [ready, initialPath, scrollTo]);

  if (patches.isPending) {
    return (
      <div className="mt-2">
        <FileRowsSkeleton label="Loading changes…" rows={3} />
      </div>
    );
  }
  if (patches.isError) {
    return (
      <Notice
        icon="AlertCircle"
        title="Changes failed to load"
        detail={errorText(patches.error)}
        onRetry={() => void patches.refetch()}
      />
    );
  }
  if (!files || files.length === 0) {
    return source.kind === "commit" ? (
      <Notice
        icon="FileDiff"
        title="No file changes"
        detail="This commit records no file contents. Merges and empty commits look like this."
      />
    ) : (
      <Notice
        icon="Check"
        title="No uncommitted changes"
        detail={
          paths
            ? "These files have no changes now. They were committed or discarded."
            : "The worktree has no changes now. They were committed or discarded."
        }
      />
    );
  }

  // The diffs follow the list's order, so the two read the same way down.
  const byPath = new Map(files.map((file) => [file.path, file]));

  return (
    <section
      ref={section}
      /*
       * Opts this list into monokai's diff-header treatment. bb gates the same
       * rules on its own diff toolbar, which a plugin panel never has.
       */
      data-monokai-diff-surface
      className="mt-2 flex flex-col gap-1.5"
      aria-label="Changes"
    >
      <ChangedFilesCard
        title="Changed files"
        count={files.length}
        stats={truncated ? null : <LineStats added={totals.added} removed={totals.removed} />}
        open={listOpen}
        onToggle={() => setListOpen((current) => !current)}
      >
        <FileList
          changes={changes}
          mode={mode}
          active={active}
          followFocus
          onSelect={(path) => {
            setActive(path);
            scrollTo(path);
          }}
        />
      </ChangedFilesCard>
      {fileOrder(changes, mode).map((path) => (
        <FileCard key={path} file={byPath.get(path)!} source={source} openFile={openFile} />
      ))}
    </section>
  );
}
