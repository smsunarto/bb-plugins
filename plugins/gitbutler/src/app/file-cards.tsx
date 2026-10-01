import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_useCodeTheme as useCodeTheme,
} from "@get-bb/plugin-sdk/app";
import { getSingularPatch } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { ChangeKind, FilePatch, PatchSource } from "../shared/schema.ts";
import { ChangedFilesCard, FileList, LineStats, fileOrder, useListMode } from "./file-list.tsx";
import { Loading, Notice, errorText } from "./notice.tsx";
import { COMMIT_QUERY } from "./query-client.ts";
import { rpc, defined } from "./rpc.ts";

const REFRESH_INTERVAL_MS = 10_000;
const COPIED_FEEDBACK_MS = 1_200;
/** Room left above a file scrolled to, so its card's top edge stays in view. */
const SCROLL_MARGIN_PX = 8;
/** How long the opened file is held in place while the diffs above it render. */
const PIN_MS = 2_000;

type Parsed = ReturnType<typeof getSingularPatch>;

function parse(patch: string): Parsed | null {
  if (patch === "") return null;
  try {
    return getSingularPatch(patch);
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
 * bb's diff panel draws its own file header in the light DOM, and this panel
 * renders inside the same secondary-panel shelf. Reproducing that markup, down
 * to the `model` prop `plugins/monokai` reads off the fiber, means monokai's
 * header rules and its injected change icon apply here verbatim. Matching it
 * by eye against Pierre's shadow-root header never converged.
 */
function FileHeader({
  model,
  open,
  added,
  removed,
  hasDiff,
  bodyId,
  onToggle,
}: {
  model: { path: string; label: string; changeKind: ChangeKind };
  open: boolean;
  added: number;
  removed: number;
  hasDiff: boolean;
  bodyId: string;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);

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
              className="size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none"
              aria-hidden
            />
          </button>
          {/* monokai's content script prepends the change icon into this span. */}
          <span className="flex min-w-0 flex-1 items-center gap-1.5 pl-[1ch]">
            {/* bb makes the filename a button that opens the file. This panel
                has nowhere to open it, so it toggles the row instead, which
                also gives the disclosure a target worth aiming at. */}
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
            <button
              type="button"
              aria-label={`Copy path for ${model.path}`}
              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground"
              onClick={async () => {
                await navigator.clipboard.writeText(model.path);
                setCopied(true);
                setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
              }}
            >
              <Icon name={copied ? "Check" : "Copy"} className="size-3" aria-hidden />
            </button>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <span className="whitespace-nowrap text-xs tabular-nums">
            {hasDiff ? (
              <>
                <span className="text-diff-added">+{added}</span>{" "}
                <span className="text-diff-removed">-{removed}</span>
              </>
            ) : (
              /* Every other row ends in a count pair. A bare change letter in
                 that slot read as a count, so say plainly there is none. */
              <span className="text-muted-foreground">No diff</span>
            )}
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * One file: bb's own header, always drawn, and Pierre's diff body below it once
 * the row is open.
 */
function FileCard({ file }: { file: FilePatch }) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const onToggle = () => setOpen((current) => !current);
  const { mode, name } = useCodeTheme();
  const parsed = useMemo(() => parse(file.patch), [file.patch]);
  const counts = useMemo(() => countLines(parsed), [parsed]);
  const model = useMemo(
    () => ({ path: file.path, label: file.path, changeKind: file.kind }),
    [file.kind, file.path],
  );

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
    <div
      className="overflow-hidden rounded-lg border border-border bg-card"
      data-file-card={file.path}
    >
      <FileHeader
        model={model}
        open={open}
        added={counts.added}
        removed={counts.removed}
        hasDiff={parsed !== null}
        bodyId={bodyId}
        onToggle={onToggle}
      />
      <div id={bodyId} hidden={!open}>
        {open ? (
          parsed ? (
            <div className="gb-diff border-t border-border">
              {/* One phrasing for one condition, here and in the branch below. */}
              {file.truncated ? (
                <p className="border-b border-border px-2 py-1 text-[11px] text-warning">
                  This diff is too large to show in full. Open the file in your editor to read the
                  rest.
                </p>
              ) : null}
              <FileDiff disableWorkerPool fileDiff={parsed} options={bodyOptions} />
            </div>
          ) : (
            <p className="border-t border-border px-2.5 py-1.5 text-[11px] leading-normal text-muted-foreground">
              {file.truncated
                ? "This diff is too large to show. Open the file in your editor to read it."
                : "No text to show. The file is binary or its contents did not change."}
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}

/**
 * One `but diff` call for a commit or the worktree, with the file list and line
 * totals derived from it. Keyed off the query result, not a fresh `?? []`, so
 * the derivations run once per fetch rather than once per render.
 */
export function usePatches(
  threadId: string,
  repositoryKey: string | undefined,
  source: PatchSource,
) {
  const patches = rpc.patches.useQuery(
    defined({ threadId, repositoryKey, source }),
    // A commit's diff is fixed by its id. The worktree's is not, so that one
    // is refreshed on the panel's usual cadence.
    source.kind === "commit" ? COMMIT_QUERY : { staleTime: REFRESH_INTERVAL_MS },
  );
  const files = patches.data?.files;
  const changes = useMemo(
    () => (files ?? []).map((file) => ({ path: file.path, kind: file.kind })),
    [files],
  );
  const totals = useMemo(
    () =>
      (files ?? []).reduce(
        (total, file) => {
          const { added, removed } = countLines(parse(file.patch));
          return { added: total.added + added, removed: total.removed + removed };
        },
        { added: 0, removed: 0 },
      ),
    [files],
  );
  return { patches, files, changes, totals };
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
}: {
  threadId: string;
  repositoryKey: string | undefined;
  source: PatchSource;
  initialPath: string | null;
}) {
  const [listOpen, setListOpen] = useState(true);
  const [mode] = useListMode();
  const [active, setActive] = useState(initialPath);
  const section = useRef<HTMLElement>(null);
  const { patches, files, changes, totals } = usePatches(threadId, repositoryKey, source);

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

  if (patches.isPending) return <Loading label="Loading changes…" />;
  if (patches.isError) {
    return (
      <Notice
        title="Changes failed to load"
        detail={errorText(patches.error)}
        onRetry={() => void patches.refetch()}
      />
    );
  }
  if (!files || files.length === 0) {
    return (
      <Notice
        title="No file changes"
        detail="This commit records no file contents. Merges and empty commits look like this."
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
        stats={<LineStats added={totals.added} removed={totals.removed} />}
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
        <FileCard key={path} file={byPath.get(path)!} />
      ))}
    </section>
  );
}
