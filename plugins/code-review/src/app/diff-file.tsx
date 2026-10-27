import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import {
  UrlLink,
  experimental_Icon as Icon,
  experimental_useCodeTheme as useCodeTheme,
} from "@get-bb/plugin-sdk/app";
import { FileDiff, useStableCallback } from "@pierre/diffs/react";
import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs/react";
import { lfsFromPatch } from "../shared/lfs.ts";
import { type Preview, previewOf } from "../shared/previews.ts";
import { sameRevision } from "../shared/schema.ts";
import type {
  ChangedFile,
  Comparison,
  DiffRevision,
  DiffSide,
  FileStatus,
  Finding,
  PullRequest,
  ReviewThread,
} from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { CONTROL_HOVER_TRANSITION } from "./components/ui/motion.ts";
import { ReviewMark } from "./bb-review.tsx";
import { FindingCard } from "./finding.tsx";
import { formatBytes, plural } from "./format.ts";
import { cn } from "./lib/utils.ts";
import {
  commentTarget,
  composerAnnotation,
  diffLines,
  drawnRows,
  fileAnchorId,
  githubFileUrl,
  parseFilePatch,
  placeFindings,
  placeThreads,
  toAnnotationSide,
} from "./patch.ts";
import type { Annotation, AnnotationData, CommentTarget, DiffLines } from "./patch.ts";
import { NewCommentForm } from "./comment-form.tsx";
import { Segmented } from "./previews/common.tsx";
import { FilePreview } from "./previews/file-preview.tsx";
import { ReviewThreadView } from "./review-thread.tsx";
import { Chip } from "./status.tsx";

export type DiffStyle = "unified" | "split";

/** A diff this long starts folded, behind a "Show diff", so a lockfile cannot stall the tab. */
const LARGE_DIFF_LINES = 1000;

export function isLargeFile(file: Pick<ChangedFile, "additions" | "deletions">): boolean {
  return file.additions + file.deletions > LARGE_DIFF_LINES;
}

/**
 * How far ahead of the viewport a diff mounts. Far enough that a steady
 * scroll never meets an empty card, near enough that a hundred-file pull
 * request highlights a handful of files at a time.
 */
const MOUNT_AHEAD = "1500px 0px";

/** Pierre's row height: `--diffs-line-height` in `.cr-diff` (code-review.css). */
const ROW_PX = 20;
/** Roughly what a hunk separator adds, for the placeholder's height. */
const SEPARATOR_PX = 32;

const STATUS_LOOK: Readonly<Partial<Record<FileStatus, { label: string; tone: string }>>> = {
  added: { label: "Added", tone: "text-diff-added" },
  removed: { label: "Deleted", tone: "text-diff-removed" },
  renamed: { label: "Renamed", tone: "text-pr-merged" },
  copied: { label: "Copied", tone: "text-pr-merged" },
};

const ICON_BUTTON = cn(
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
  CONTROL_HOVER_TRANSITION,
);

/**
 * True once `ref` comes within {@link MOUNT_AHEAD} of the Changes tab's
 * scroll area, and from then on. The observer's root has to be that area:
 * a margin on the viewport does not reach past the clipping scroller.
 */
function useNearView(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { root: element.closest<HTMLElement>("[data-cr-scroll]"), rootMargin: MOUNT_AHEAD },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

/**
 * The file on GitHub, anchored once its hash is in. The pull request's Files
 * tab until then. None without a pull request.
 */
function useGithubFileUrl(prUrl: string | null, path: string): string | null {
  const [url, setUrl] = useState(prUrl === null ? null : `${prUrl}/files`);
  useEffect(() => {
    if (prUrl === null) return;
    let live = true;
    void (async () => {
      try {
        const anchored = await githubFileUrl(prUrl, path);
        if (live) setUrl(anchored);
      } catch {
        // Without SubtleCrypto (an insecure origin), the Files tab is the link.
      }
    })();
    return () => {
      live = false;
    };
  }, [prUrl, path]);
  return url;
}

type View = "preview" | "diff";
const VIEWS: readonly { value: View; label: string }[] = [
  { value: "preview", label: "Preview" },
  { value: "diff", label: "Diff" },
];

function FileHeader({
  file,
  open,
  bodyId,
  threadCount,
  githubUrl,
  onViewedChange,
  reviewLabel,
  view,
  onView,
  lfs,
}: {
  file: ChangedFile;
  open: boolean;
  bodyId: string;
  threadCount: number;
  githubUrl: string | null;
  /** Null until review marks are available. */
  onViewedChange: ((viewed: boolean) => void) | null;
  reviewLabel: string;
  /** The body's view, when the file has both a preview and a text diff. */
  view: View | null;
  onView: (view: View) => void;
  /** The Git LFS object sizes a pointer diff names, before and after. */
  lfs: { base: number | null; head: number | null } | null;
}) {
  const status = STATUS_LOOK[file.status];
  const shown = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  const viewed = file.viewed === "viewed";
  return (
    // Sticky inside the tab's scroll area, so the path and review toggle stay
    // in reach down a long diff.
    <div
      className={cn(
        // `bg-card` is a 4% ink layer, so on its own the diff scrolls through it. The
        // card's layer over the page ground matches the card and hides what passes under.
        "sticky top-0 z-10 flex min-h-9 min-w-0 items-center gap-2 bg-background [background-image:linear-gradient(var(--card),var(--card))] py-1 pr-1.5 pl-1",
        open && "border-b border-border",
      )}
    >
      <label
        className={cn(
          ICON_BUTTON,
          "relative has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
        )}
        title={
          onViewedChange
            ? `${viewed ? "Unmark" : "Mark"} ${file.path} as ${reviewLabel.toLowerCase()}`
            : "Review progress unavailable"
        }
      >
        <input
          type="checkbox"
          className="peer size-4 cursor-pointer appearance-none rounded-[3px] border border-muted-foreground/60 bg-background outline-none checked:border-primary checked:bg-primary"
          checked={viewed}
          aria-controls={bodyId}
          aria-describedby={`${bodyId}-visibility`}
          disabled={!onViewedChange}
          onChange={(event) => onViewedChange?.(event.target.checked)}
        />
        <Icon
          name="Check"
          className="pointer-events-none absolute size-3 text-primary-foreground opacity-0 peer-checked:opacity-100"
          aria-hidden
        />
        <span id={`${bodyId}-visibility`} hidden>
          {open ? "Diff expanded" : "Diff collapsed"}
        </span>
        <span className="sr-only">
          {reviewLabel} {file.path}
        </span>
      </label>
      <h3 className="flex min-w-0 flex-1 items-center gap-2">
        {/* `dir=rtl` keeps a long path's file name in view. The LRM stops a
            leading dot from being reordered. */}
        <span
          dir="rtl"
          className="min-w-0 truncate font-mono text-xs font-medium"
          title={shown}
          translate="no"
        >
          {`\u200e${shown}`}
        </span>
        {status ? <Chip tone={status.tone}>{status.label}</Chip> : null}
        {file.generated ? (
          <Chip tone="text-muted-foreground" title="Generated, so it starts folded at the end">
            Generated
          </Chip>
        ) : null}
        {file.viewed === "dismissed" ? (
          <Chip tone="text-attention" title="Changed since you marked it viewed">
            Changed
          </Chip>
        ) : null}
        {lfs ? (
          <Chip
            tone="text-muted-foreground"
            title={`Stored with Git LFS: ${lfs.base === null ? "new" : formatBytes(lfs.base)} → ${lfs.head === null ? "deleted" : formatBytes(lfs.head)}`}
          >
            LFS
          </Chip>
        ) : null}
      </h3>
      {open && view ? (
        <Segmented label={`Show ${file.path} as`} options={VIEWS} value={view} onChange={onView} />
      ) : null}
      <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums">
        {threadCount > 0 ? (
          <span
            className="inline-flex items-center gap-1 text-muted-foreground"
            title={plural(threadCount, "comment thread")}
          >
            <Icon name="MessageSquare" className="size-3" aria-hidden />
            {threadCount}
            <span className="sr-only"> comment threads</span>
          </span>
        ) : null}
        <span>
          <span className="text-diff-added">+{file.additions}</span>{" "}
          <span className="text-diff-removed">−{file.deletions}</span>
          <span className="sr-only">
            {` ${plural(file.additions, "line")} added, ${plural(file.deletions, "line")} removed`}
          </span>
        </span>
      </span>
      {githubUrl ? (
        <UrlLink
          href={githubUrl}
          className={ICON_BUTTON}
          aria-label={`Open ${file.path} on GitHub`}
          title="Open on GitHub"
        >
          <Icon name="ExternalLink" className="size-3.5" aria-hidden />
        </UrlLink>
      ) : null}
    </div>
  );
}

/**
 * Why there is no diff to draw, and where to read the file instead. GitHub
 * counts no lines and sends no hunks both for a pure rename and for a binary
 * file renamed and changed, and says nothing that tells the two apart, so a
 * rename without hunks keeps the link too. An unpublished branch's diff
 * comes from git, with nowhere else to read it.
 */
function NoDiff({ file, githubUrl }: { file: ChangedFile; githubUrl: string | null }) {
  const source = githubUrl ? "GitHub sends" : "Git shows";
  const text = file.patch
    ? "This diff could not be read."
    : file.status === "renamed" && file.additions + file.deletions === 0
      ? `Renamed from ${file.previousPath ?? "another path"}. ${source} no diff for it, so only its name changed, or it is binary.`
      : `${source} no diff for this file. It is binary, or too large to show here.`;
  return (
    <p className="px-3 py-2.5 leading-normal text-muted-foreground">
      {text}
      {githubUrl ? (
        <>
          {" "}
          <UrlLink href={githubUrl} className="text-primary underline-offset-2 hover:underline">
            View on GitHub
          </UrlLink>
        </>
      ) : null}
    </p>
  );
}

/** The threads and findings that have no line in the diff, listed above it. */
function Detached({
  pr,
  heading,
  threads,
  findings,
  findingsStale,
  revision,
}: {
  pr: PullRequest | null;
  heading: string;
  threads: readonly ReviewThread[];
  findings: readonly Finding[];
  findingsStale: boolean;
  revision: DiffRevision;
}) {
  if (threads.length === 0 && findings.length === 0) return null;
  return (
    <section
      aria-label={heading}
      className="flex flex-col gap-2 border-b border-border px-3 py-2.5"
    >
      <h4 className="font-medium text-muted-foreground">{heading}</h4>
      {pr
        ? threads.map((thread) => (
            <ReviewThreadView key={thread.id} pr={pr} thread={thread} showContext />
          ))
        : null}
      {findings.map((finding) => (
        <InlineFinding
          key={finding.id}
          pr={pr}
          finding={finding}
          stale={findingsStale}
          revision={revision}
        />
      ))}
    </section>
  );
}

/** Outdated threads, folded under one disclosure as GitHub does. */
function Outdated({ pr, threads }: { pr: PullRequest; threads: readonly ReviewThread[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (threads.length === 0) return null;
  return (
    <div className="border-b border-border">
      <button
        type="button"
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-1.5 px-2 text-left text-muted-foreground hover:bg-state-hover hover:text-foreground",
          CONTROL_HOVER_TRANSITION,
        )}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon
          name="ChevronRight"
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
          aria-hidden
        />
        {plural(threads.length, "outdated comment")}
      </button>
      <div id={listId} hidden={!open} className="flex flex-col gap-2 px-3 pb-2.5">
        {open
          ? threads.map((thread) => (
              <ReviewThreadView key={thread.id} pr={pr} thread={thread} showContext />
            ))
          : null}
      </div>
    </div>
  );
}

/** A bb finding, said to be one, since inline it sits among people's comments. */
function InlineFinding({
  pr,
  finding,
  stale,
  revision,
}: {
  pr: PullRequest | null;
  finding: Finding;
  stale: boolean;
  /** The diff on screen. */
  revision: DiffRevision;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 font-sans text-xs leading-normal text-foreground">
      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <ReviewMark className="size-3" />
        {stale ? "bb finding, from a review of an older commit" : "bb finding"}
      </p>
      {/* Not stale means bb reviewed this diff, so the finding's lines are
          this diff's lines even while the pull request has moved on. */}
      <FindingCard finding={finding} stale={stale} pr={pr} reviewed={revision} />
    </div>
  );
}

const NO_LINES: DiffLines = new Map();

/** An annotation row other than the new-comment form: a thread or a bb finding. */
function AnnotationRow({
  data,
  pr,
  revision,
  findingsStale,
}: {
  data: Exclude<AnnotationData, { kind: "composer" }>;
  pr: PullRequest | null;
  /** The diff on screen. */
  revision: DiffRevision;
  findingsStale: boolean;
}) {
  if (data.kind === "thread") {
    return pr ? <ReviewThreadView pr={pr} thread={data.thread} /> : null;
  }
  return <InlineFinding pr={pr} finding={data.finding} stale={findingsStale} revision={revision} />;
}

/** Pierre keys annotation rows by position, so each row is keyed by what it holds. */
function annotationKey(data: AnnotationData): string {
  if (data.kind === "thread") return `thread:${data.thread.id}`;
  if (data.kind === "finding") return `finding:${data.finding.id}`;
  return "composer";
}

/**
 * The diff itself, with threads and findings inline. On a pull request, the
 * gutter's "+" opens a comment form on that line; dragging it, or selecting
 * line numbers first, comments on a range. Pierre mounts only once the card
 * nears the viewport.
 */
function Diff({
  pr,
  file,
  parsed,
  lines,
  annotations: placed,
  revision,
  findingsStale,
  diffStyle,
  focus,
}: {
  pr: PullRequest | null;
  file: ChangedFile;
  parsed: FileDiffMetadata;
  lines: DiffLines;
  annotations: readonly Annotation[];
  revision: DiffRevision;
  findingsStale: boolean;
  diffStyle: DiffStyle;
  focus: { line: number; side: DiffSide } | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const near = useNearView(box);
  const { mode, name } = useCodeTheme();
  const [selected, setSelected] = useState<SelectedLineRange | null>(null);
  /**
   * The open comment form, the diff its lines were picked in, and once saved,
   * the thread it became. A push can move the head while the form is open,
   * and a retarget the base.
   */
  const [composer, setComposer] = useState<{
    target: CommentTarget;
    picked: DiffRevision;
    saved: string | null;
  } | null>(null);

  /*
   * Pierre keys annotation rows by position. The form goes last, after every
   * thread, so opening it shifts nothing, and a thread saved from it lands at
   * its index: the thread replaces the form in the same render, and nothing
   * remounts.
   */
  const savedInView =
    composer?.saved != null &&
    placed.some(
      ({ metadata }) => metadata.kind === "thread" && metadata.thread.id === composer.saved,
    );
  const annotations = useMemo(
    () =>
      composer && !savedInView
        ? [...placed, composerAnnotation(composer.target, composer.picked.headRefOid)]
        : [...placed],
    [placed, composer, savedInView],
  );
  // Once the saved thread is drawn, the form and its line selection are done.
  // Reset while rendering, so no frame shows both.
  if (savedInView) {
    setComposer(null);
    setSelected(null);
  }

  useEffect(() => {
    if (!focus) return;
    const side = toAnnotationSide(focus.side);
    setSelected({ start: focus.line, end: focus.line, side, endSide: side });
  }, [focus]);

  const onGutterUtilityClick = useStableCallback((range: SelectedLineRange) => {
    const target = commentTarget(lines, range);
    if (!target) return;
    setComposer({ target, picked: revision, saved: null });
    setSelected(range);
  });
  const onLineSelectionEnd = useStableCallback((range: SelectedLineRange | null) => {
    setSelected(range);
  });
  const closeComposer = useStableCallback(() => {
    setComposer(null);
    setSelected(null);
  });
  const composerSaved = useStableCallback((threadId: string) => {
    setComposer((current) => current && { ...current, saved: threadId });
  });
  // A branch has no pull request to hold a comment.
  const commentable = pr !== null;
  const options = useMemo(
    () => ({
      disableFileHeader: true,
      diffStyle,
      theme: name,
      themeType: mode,
      enableGutterUtility: commentable,
      enableLineSelection: true,
      onGutterUtilityClick,
      onLineSelectionEnd,
    }),
    [diffStyle, mode, name, commentable, onGutterUtilityClick, onLineSelectionEnd],
  );

  const form =
    composer && pr ? (
      <NewCommentForm
        pr={pr}
        headRefOid={composer.picked.headRefOid}
        baseRefName={composer.picked.baseRefName}
        linesMoved={!sameRevision(composer.picked, revision)}
        path={file.path}
        target={composer.target}
        onSaved={composerSaved}
        onClose={closeComposer}
      />
    ) : null;

  const drawn = drawnRows(parsed, diffStyle);
  return (
    <div ref={box}>
      {near ? (
        <FileDiff<AnnotationData>
          fileDiff={parsed}
          options={options}
          lineAnnotations={annotations}
          renderAnnotation={({ metadata }) => (
            <div key={annotationKey(metadata)} className="max-w-3xl px-2 py-1.5">
              {metadata.kind === "composer" ? (
                form
              ) : (
                <AnnotationRow
                  data={metadata}
                  pr={pr}
                  revision={revision}
                  findingsStale={findingsStale}
                />
              )}
            </div>
          )}
          selectedLines={selected}
          className="cr-diff"
        />
      ) : (
        <div
          aria-hidden
          style={{ height: drawn.lines * ROW_PX + drawn.separators * SEPARATOR_PX }}
        />
      )}
    </div>
  );
}

/**
 * An open card's body: what has no line in the diff (file comments, outdated
 * threads, findings off the diff), then the diff. Parsed only while open, so
 * a folded card costs nothing.
 */
/** A preview mounts once its card nears the viewport, as a diff does. */
function NearView({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const near = useNearView(box);
  return <div ref={box}>{near ? children : <div aria-hidden className="h-40" />}</div>;
}

/** What the card can show besides text, and whether it shows that first. */
function previewFor(file: ChangedFile, comparison: Comparison | null) {
  if (!comparison) return null;
  const preview = previewOf(file.path);
  const lfs = lfsFromPatch(file.patch);
  // A file with no text diff still has sizes and downloads to show.
  if (!preview && !lfs && file.patch) return null;
  return { comparison, preview, lfs };
}

function FileBody({
  pr,
  file,
  threads,
  findings,
  findingsStale,
  revision,
  diffStyle,
  focus,
  githubUrl,
  preview,
  view,
  onView,
}: {
  pr: PullRequest | null;
  file: ChangedFile;
  threads: readonly ReviewThread[];
  findings: readonly Finding[];
  findingsStale: boolean;
  revision: DiffRevision;
  diffStyle: DiffStyle;
  focus: { line: number; side: DiffSide } | null;
  githubUrl: string | null;
  preview: { comparison: Comparison; preview: Preview | null } | null;
  view: View;
  onView: (view: View) => void;
}) {
  const parsed = useMemo(() => parseFilePatch(file), [file]);
  const lines = useMemo(() => (parsed ? diffLines(parsed) : NO_LINES), [parsed]);
  const placedThreads = useMemo(() => placeThreads(threads, lines), [threads, lines]);
  const placedFindings = useMemo(() => placeFindings(findings, lines), [findings, lines]);
  // Findings first and threads after, in GitHub's order, so a new thread
  // is always the last row; see `Diff`.
  const annotations = useMemo(
    () => [...placedFindings.annotations, ...placedThreads.annotations],
    [placedThreads, placedFindings],
  );

  if (!parsed || (preview && view === "preview")) {
    return (
      <>
        {/* With no diff, no thread has a row, so every one is listed. */}
        <Detached
          pr={pr}
          heading="Comments"
          threads={threads}
          findings={findings}
          findingsStale={findingsStale}
          revision={revision}
        />
        {preview ? (
          <NearView>
            <FilePreview
              comparison={preview.comparison}
              file={file}
              preview={preview.preview}
              onShowText={parsed ? () => onView("diff") : null}
            />
          </NearView>
        ) : null}
        {!parsed && !preview?.preview ? <NoDiff file={file} githubUrl={githubUrl} /> : null}
      </>
    );
  }
  return (
    <>
      <Detached
        pr={pr}
        heading="Comments on this file"
        threads={placedThreads.fileLevel}
        findings={placedFindings.elsewhere}
        findingsStale={findingsStale}
        revision={revision}
      />
      {pr ? <Outdated pr={pr} threads={placedThreads.outdated} /> : null}
      <Diff
        pr={pr}
        file={file}
        parsed={parsed}
        lines={lines}
        annotations={annotations}
        revision={revision}
        findingsStale={findingsStale}
        diffStyle={diffStyle}
        focus={focus}
      />
    </>
  );
}

/** A diff that starts folded, unread: a generated file, or one too long to draw at once. */
export function startsFolded(file: ChangedFile): boolean {
  return file.viewed !== "viewed" && (file.generated || isLargeFile(file));
}

/** A diff folded by `startsFolded` says why, and opens on request. */
function FoldedDiffHint({ file, onShow }: { file: ChangedFile; onShow: () => void }) {
  const lines = plural(file.additions + file.deletions, "changed line");
  return (
    <p className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-muted-foreground">
      {file.generated
        ? `Generated file, ${lines}, folded.`
        : `Large diff, ${lines}, folded to keep the page fast.`}
      <Button variant="outline" size="sm" className="h-6 px-2 text-xs font-normal" onClick={onShow}>
        Show diff
      </Button>
    </p>
  );
}

/**
 * One changed file: a sticky header with its Viewed box, and the body below
 * it while the card is open. Without a pull request (an unpublished branch)
 * there are no threads, comments, or Viewed marks: only the diff and bb's
 * findings.
 */
export const DiffFile = memo(function DiffFile({
  pr,
  file,
  headRefOid,
  baseRefName,
  threads,
  findings,
  findingsStale,
  open,
  diffStyle,
  focus,
  onOpenChange,
  onViewedChange,
  reviewLabel = "Viewed",
  comparison = null,
}: {
  pr: PullRequest | null;
  file: ChangedFile;
  /** Where whole files are read for previews. Null shows text diffs only. */
  comparison?: Comparison | null;
  /** The head these patches belong to. New comments are counted against it. */
  headRefOid: string;
  /** The base these patches compare against. A retarget changes it without a new head. */
  baseRefName: string;
  threads: readonly ReviewThread[];
  findings: readonly Finding[];
  /** The findings come from a review of an older head. */
  findingsStale: boolean;
  open: boolean;
  diffStyle: DiffStyle;
  /** A line to select and bring into view. A new object for each reveal. */
  focus: { line: number; side: DiffSide } | null;
  onOpenChange: (path: string, open: boolean) => void;
  onViewedChange: ((file: ChangedFile, viewed: boolean) => void) | null;
  reviewLabel?: string;
}) {
  const bodyId = useId();
  const githubUrl = useGithubFileUrl(pr?.url ?? null, file.path);
  const folded = !open && startsFolded(file);
  const revision = useMemo(() => ({ headRefOid, baseRefName }), [headRefOid, baseRefName]);
  const preview = useMemo(() => previewFor(file, comparison), [file, comparison]);
  const [chosen, setChosen] = useState<View>("preview");
  // A line asked for (a finding, a thread) is on the text diff.
  useEffect(() => {
    if (focus && file.patch) setChosen("diff");
  }, [focus, file.patch]);
  const view: View = preview ? chosen : "diff";
  const lfs = preview?.lfs
    ? { base: preview.lfs.base?.size ?? null, head: preview.lfs.head?.size ?? null }
    : null;

  return (
    // Clipped, not hidden: hidden overflow would make the card the sticky
    // header's scroll container, and the header would scroll away with it.
    <article
      id={fileAnchorId(file.path)}
      data-file-card={file.path}
      aria-label={file.path}
      className="scroll-mt-2 overflow-clip rounded-md border border-border bg-card"
    >
      <FileHeader
        file={file}
        open={open}
        bodyId={bodyId}
        threadCount={threads.length}
        githubUrl={githubUrl}
        reviewLabel={reviewLabel}
        onViewedChange={onViewedChange ? (viewed) => onViewedChange(file, viewed) : null}
        view={preview && file.patch ? view : null}
        onView={setChosen}
        lfs={lfs}
      />
      {folded ? <FoldedDiffHint file={file} onShow={() => onOpenChange(file.path, true)} /> : null}
      <div id={bodyId} hidden={!open}>
        {open ? (
          <FileBody
            pr={pr}
            file={file}
            threads={threads}
            findings={findings}
            findingsStale={findingsStale}
            revision={revision}
            diffStyle={diffStyle}
            focus={focus}
            githubUrl={githubUrl}
            preview={preview}
            view={view}
            onView={setChosen}
          />
        ) : null}
      </div>
    </article>
  );
});
