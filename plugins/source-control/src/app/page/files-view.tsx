/**
 * A Change's files at one revision, as the Files tab (and a commit in the
 * Commits tab) shows them: the tree beside a column of file cards whose
 * diffs Pierre virtualizes against the column, as gitbutler's scroll area
 * does. A card asks for its patch only when open and near the viewport;
 * lockfiles and generated files start collapsed.
 */
import {
  experimental_useCodeTheme as useCodeTheme,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { Virtualizer } from "@pierre/diffs";
import { FileDiff, VirtualizerContext } from "@pierre/diffs/react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { describeProblem, type FilePatch } from "../../core/change.ts";
import type { ChangeKey } from "../../core/ids.ts";
import type { Anchor, ReviewItem } from "../../core/items.ts";
import { startsCollapsed, type ChangeFile, type ReviewRevision } from "../../core/review.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import {
  FileName,
  FileRowsSkeleton,
  FileStatus,
  PatchesProblem,
  parsePatch,
} from "../file-cards.tsx";
import { cx, plural } from "../format.ts";
import { useChangeReview, useReviewActions, type ReviewActions } from "../review-data.ts";
import {
  FileReviewInterner,
  annotationSide,
  entryAnchor,
  lineKey,
  patchLinesOf,
  sameArray,
  type FileReview,
  type PatchLines,
} from "../review-model.ts";
import {
  AddCommentButton,
  LineThread,
  type AnnotationContext,
  type ComposerEntry,
  type LineEntry,
} from "./annotations.tsx";
import { FileTree } from "./file-tree.tsx";
import { Chevron } from "./icons.tsx";
import { usePatch, usePatchStore, type PatchStore } from "./patches.ts";
import { FocusContext } from "./review-focus.ts";

/** Lockfiles and generated output last, as code-review's reading order puts them. */
export function readingOrder(files: readonly ChangeFile[]): ChangeFile[] {
  return files.toSorted(
    (a, b) =>
      Number(startsCollapsed(a.path)) - Number(startsCollapsed(b.path)) ||
      a.path.localeCompare(b.path),
  );
}

// ── Near the viewport ──────────────────────────────────────────────────

/** Told when the card comes within AHEAD of the viewport, and when it leaves again. */
type Watch = (path: string, element: Element | null, onNear: (near: boolean) => void) => void;

type Column = {
  watch: Watch;
  /** The cards by path, for scrolling to one. */
  cards: Map<string, Element>;
  /** Each card's last drawn height, so a far card keeps its place as one empty box. */
  heights: Map<string, number>;
};

const ColumnContext = createContext<Column | null>(null);

/** Cards drawn before the observer reports: about a screen of them. */
const EAGER_CARDS = 8;

/** How far ahead of the viewport a card asks for its patch, and draws at all. */
const AHEAD = "1200px 0px";

function useColumn(
  scroller: RefObject<HTMLElement | null>,
  onCurrent: (path: string) => void,
): Column {
  const current = useRef(onCurrent);
  useLayoutEffect(() => {
    current.current = onCurrent;
  });
  const [column] = useState(() => {
    const cards = new Map<string, Element>();
    const near = new Map<Element, (near: boolean) => void>();
    const heights = new Map<string, number>();
    // Heights come from ResizeObserver entries, after layout: nothing is measured on demand.
    const sized =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              const path = paths.get(entry.target);
              const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
              if (path && height > 0) heights.set(path, height);
            }
          });
    const paths = new Map<Element, string>();
    let ahead: IntersectionObserver | null = null;
    let top: IntersectionObserver | null = null;
    const pending: Element[] = [];
    const inBand = new Set<Element>();
    const setup = (root: HTMLElement) => {
      if (typeof IntersectionObserver === "undefined") return;
      ahead = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) near.get(entry.target)?.(entry.isIntersecting);
        },
        { root, rootMargin: AHEAD },
      );
      // The first card in the top band is the one being read. A jump or a card resizing can
      // pass several through it in one batch, so the band is tracked whole and read in page order.
      top = new IntersectionObserver(
        (entries) => {
          for (const entry of entries)
            if (entry.isIntersecting) inBand.add(entry.target);
            else inBand.delete(entry.target);
          let first: Element | null = null;
          for (const element of inBand)
            if (!first || element.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)
              first = element;
          const path = first ? paths.get(first) : undefined;
          if (path) current.current(path);
        },
        { root, rootMargin: "-8px 0px -70% 0px" },
      );
      for (const element of pending.splice(0)) {
        ahead.observe(element);
        top.observe(element);
      }
    };
    const watch: Watch = (path, element, onNear) => {
      if (!element) return;
      cards.set(path, element);
      paths.set(element, path);
      near.set(element, onNear);
      sized?.observe(element);
      if (typeof IntersectionObserver === "undefined") {
        // No observer (tests, very old engines): every open card is near.
        onNear(true);
        return;
      }
      if (ahead && top) {
        ahead.observe(element);
        top.observe(element);
      } else pending.push(element);
    };
    return {
      column: { watch, cards, heights },
      setup,
      teardown() {
        ahead?.disconnect();
        top?.disconnect();
        ahead = top = null;
      },
      forget(element: Element) {
        near.delete(element);
        paths.delete(element);
        sized?.unobserve(element);
        inBand.delete(element);
        ahead?.unobserve(element);
        top?.unobserve(element);
      },
    };
  });
  useEffect(() => {
    const element = scroller.current;
    if (element) column.setup(element);
    return () => column.teardown();
  }, [column, scroller]);
  return useMemo(
    () => ({
      cards: column.column.cards,
      heights: column.column.heights,
      watch: (path, element, onNear) => {
        if (element) column.column.watch(path, element, onNear);
        else {
          const old = column.column.cards.get(path);
          if (old) {
            column.forget(old);
            column.column.cards.delete(path);
          }
        }
      },
    }),
    [column],
  );
}

// ── A file card ────────────────────────────────────────────────────────

/** Space a diff will take, reserved while its patch loads so the column does not jump. */
function reservedHeight(file: ChangeFile): number {
  const lines = Math.min(file.additions + file.deletions, 30);
  return Math.max(2, lines) * 20 + 16;
}

/** A card never drawn: its header, and the space its diff will reserve. */
function farHeight(file: ChangeFile, open: boolean): number {
  return 36 + 2 + (open ? reservedHeight(file) : 0);
}

// ── Annotations ────────────────────────────────────────────────────────

type DiffAnnotation = { side: "additions" | "deletions"; lineNumber: number; metadata: string };

type Lines = {
  /** Each shown line's entries, by `lineKey`. */
  byLine: ReadonlyMap<string, readonly LineEntry[]>;
  /** Entries whose line the diff does not show: on another head, on the whole file, or no diff to show. */
  loose: readonly LineEntry[];
  annotations: readonly DiffAnnotation[];
};

const NO_ENTRIES: readonly LineEntry[] = Object.freeze([]);
const NO_ANNOTATIONS: readonly DiffAnnotation[] = Object.freeze([]);

/**
 * A file's entries by the line they sit under. A line whose entries are the
 * same objects keeps its array, and the annotation list keeps its identity
 * while the same lines carry entries, so Pierre redraws the diff only when a
 * line gains or loses its annotation.
 */
class LineInterner {
  private last: Lines = { byLine: new Map(), loose: NO_ENTRIES, annotations: NO_ANNOTATIONS };
  private lastKeys = "";

  build(entries: readonly LineEntry[], shown: PatchLines | null, head: string): Lines {
    const byLine = new Map<string, LineEntry[]>();
    const loose: LineEntry[] = [];
    for (const entry of entries) {
      const anchor = entry.kind === "composer" ? entry.anchor : entryAnchor(entry);
      // Lines numbered at another head are not this diff's lines.
      const key =
        anchor.line === null || anchor.head !== head
          ? null
          : lineKey(annotationSide(anchor), anchor.line);
      if (!shown || key === null || !shown.rows.has(key)) loose.push(entry);
      else byLine.set(key, [...(byLine.get(key) ?? []), entry]);
    }
    const kept = new Map<string, readonly LineEntry[]>();
    for (const [key, list] of byLine) kept.set(key, sameArray(this.last.byLine.get(key), list));
    const keys = [...kept.keys()].toSorted(
      (a, b) => (shown?.rows.get(a) ?? 0) - (shown?.rows.get(b) ?? 0) || a.localeCompare(b),
    );
    const joined = keys.join("|");
    const annotations =
      joined === this.lastKeys
        ? this.last.annotations
        : keys.map((key) => {
            const [side, line] = key.split(":") as ["additions" | "deletions", string];
            return { side, lineNumber: Number(line), metadata: key };
          });
    this.lastKeys = joined;
    this.last = { byLine: kept, loose: sameArray(this.last.loose, loose), annotations };
    return this.last;
  }
}

type Composing = { side: "additions" | "deletions"; line: number } | null;
type Hovered = () => { lineNumber: number; side: "additions" | "deletions" } | undefined;

/**
 * A file's annotations: its entries by line, the composer the gutter's "+"
 * opens, and Pierre's render callbacks. Null `actions` draws none.
 */
function useLineAnnotations({
  path,
  review,
  actions,
  head,
  shown,
}: {
  path: string;
  review: FileReview | undefined;
  actions: ReviewActions | null;
  head: string;
  shown: PatchLines | null;
}) {
  const [composing, setComposing] = useState<Composing>(null);
  const context = useMemo<AnnotationContext | null>(
    () => (actions ? { actions, closeComposer: () => setComposing(null) } : null),
    [actions],
  );
  const composer = useMemo<ComposerEntry | null>(() => {
    if (!composing) return null;
    const anchor: Anchor = {
      path,
      line: composing.line,
      startLine: null,
      side: composing.side === "deletions" ? "LEFT" : "RIGHT",
      head,
    };
    return { kind: "composer", id: `composer:${composing.side}:${composing.line}`, anchor };
  }, [composing, path, head]);
  const [interner] = useState(() => new LineInterner());
  const lines = useMemo(() => {
    const entries: LineEntry[] = [...(review?.entries ?? NO_ENTRIES)];
    if (composer) entries.push(composer);
    return interner.build(entries, shown, head);
  }, [interner, review, composer, shown, head]);
  const { byLine } = lines;
  const renderAnnotation = useCallback(
    (annotation: DiffAnnotation) => {
      const entries = byLine.get(annotation.metadata);
      if (!entries || !context) return null;
      return (
        <LineThread
          key={annotation.metadata}
          lineKey={annotation.metadata}
          entries={entries}
          inset
          context={context}
        />
      );
    },
    [byLine, context],
  );
  const renderGutterUtility = useCallback(
    (hovered: Hovered) => (
      <AddCommentButton
        onClick={() => {
          const at = hovered();
          if (at) setComposing({ side: at.side, line: at.lineNumber });
        }}
      />
    ),
    [],
  );
  const loose =
    context && lines.loose.length > 0 ? (
      <LineThread lineKey="file" entries={lines.loose} inset={false} context={context} />
    ) : null;
  return {
    loose,
    annotations: lines.annotations as DiffAnnotation[],
    renderAnnotation: context ? renderAnnotation : undefined,
    renderGutterUtility: context ? renderGutterUtility : undefined,
  };
}

/** Why a ready file has no diff to draw. */
function emptyText(patch: FilePatch | null, file: ChangeFile): string {
  if (patch?.truncated)
    return "This diff is too large to show. Open the file on GitHub or in your editor to read it.";
  if (file.kind === "renamed" && file.previousPath) return `Renamed from ${file.previousPath}.`;
  return "No text to show. The file is binary or its contents did not change.";
}

function PatchBody({
  store,
  file,
  line,
  review,
  actions,
  head,
}: {
  store: PatchStore;
  file: ChangeFile;
  line: number | null;
  /** The file's items and drafts; undefined when the view draws none (a commit's files). */
  review: FileReview | undefined;
  actions: ReviewActions | null;
  head: string;
}) {
  const entry = usePatch(store, file.path);
  const { mode, name } = useCodeTheme();
  const commenting = actions !== null;
  const options = useMemo(
    () => ({
      disableFileHeader: true,
      diffStyle: "unified" as const,
      stickyHeader: false,
      theme: name,
      themeType: mode,
      enableGutterUtility: commenting,
    }),
    [mode, name, commenting],
  );
  const patch = entry?.state === "ready" ? entry.file : null;
  const parsed = useMemo(() => (patch ? parsePatch(patch.patch) : null), [patch]);
  const selected = useMemo(() => (line ? { start: line, end: line } : null), [line]);
  const notes = useLineAnnotations({
    path: file.path,
    review,
    actions,
    head,
    shown: patch && parsed ? patchLinesOf(patch) : null,
  });
  if (!entry || entry.state === "loading")
    return (
      <div
        aria-busy="true"
        aria-label={`Loading ${file.path}`}
        data-testid="sc-patch-loading"
        className="animate-pulse border-t border-solid border-border-hairline bg-surface-recessed motion-reduce:animate-none"
        style={{ height: reservedHeight(file) }}
      />
    );
  if (entry.state === "failed")
    return <PatchesProblem text={entry.message} onRetry={() => store.request(file.path)} />;
  if (!patch || !parsed)
    return (
      <>
        {notes.loose}
        <p
          data-testid="sc-patch-empty"
          className="m-0 border-t border-solid border-border-hairline bg-surface-recessed px-3.5 py-2 text-[11px] leading-4 text-muted-foreground"
        >
          {emptyText(patch, file)}
        </p>
      </>
    );
  return (
    <div
      data-testid="sc-patch"
      className="min-w-0 border-t border-solid border-border-hairline [--diffs-font-family:var(--font-mono,ui-monospace,monospace)] [--diffs-font-size:12px] [--diffs-line-height:20px]"
    >
      {notes.loose}
      {patch.truncated ? (
        <p className="m-0 border-b border-solid border-border-hairline px-3.5 py-1 text-[11px] leading-4 text-warning">
          This diff is too large to show in full.
        </p>
      ) : null}
      <FileDiff
        key={parsed.cacheKey}
        fileDiff={parsed}
        options={options}
        selectedLines={selected}
        lineAnnotations={notes.annotations}
        renderAnnotation={notes.renderAnnotation}
        renderGutterUtility={notes.renderGutterUtility}
      />
    </div>
  );
}

const FileCard = memo(function FileCard({
  file,
  open,
  store,
  line,
  onToggle,
  eager,
  review,
  actions,
  head,
}: {
  file: ChangeFile;
  open: boolean;
  store: PatchStore;
  line: number | null;
  onToggle: (path: string) => void;
  review: FileReview | undefined;
  actions: ReviewActions | null;
  head: string;
  /** The first cards draw at once; the rest wait for the observer to say they are near. */
  eager: boolean;
}) {
  const column = useContext(ColumnContext);
  const [near, setNear] = useState(eager);
  const watchRef = useCallback(
    (element: HTMLElement | null) => column?.watch(file.path, element, setNear),
    [column, file.path],
  );
  useEffect(() => {
    if (open && near) store.request(file.path);
  }, [open, near, store, file.path]);
  const generated = startsCollapsed(file.path);
  const card =
    "min-w-0 overflow-hidden rounded-[8px] border border-solid border-border-hairline bg-background";
  // Far from the view a card is one box of its last height: a 300-file change stays a few thousand nodes.
  if (!near)
    return (
      <section
        ref={watchRef}
        data-testid="sc-file-card"
        data-path={file.path}
        data-open={open}
        aria-label={file.path}
        className={card}
        style={{ height: column?.heights.get(file.path) ?? farHeight(file, open) }}
      />
    );
  return (
    <section
      ref={watchRef}
      data-testid="sc-file-card"
      data-path={file.path}
      data-open={open}
      aria-label={file.path}
      className={card}
    >
      <button
        type="button"
        aria-expanded={open}
        title={file.path}
        onClick={() => onToggle(file.path)}
        className="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 border-0 bg-surface-recessed ps-2.5 pe-3 text-start text-[12px] leading-4 hover:bg-surface-raised"
      >
        <Chevron
          className={cx(
            "shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            !open && "-rotate-90",
          )}
        />
        <FileStatus kind={file.kind} />
        <FileName path={file.path} />
        {generated ? (
          <span className="shrink-0 text-[11px] text-(--tertiary-foreground)">Generated</span>
        ) : null}
        {file.binary ? (
          <span className="shrink-0 text-[11px] text-(--tertiary-foreground)">Binary</span>
        ) : (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span className="text-success-foreground">+{file.additions}</span>{" "}
            <span className="text-destructive-text">−{file.deletions}</span>
          </span>
        )}
      </button>
      {open ? (
        <PatchBody
          store={store}
          file={file}
          line={line}
          review={review}
          actions={actions}
          head={head}
        />
      ) : null}
    </section>
  );
});

/**
 * After a card is revealed, scroll its column to an item's annotation once
 * Pierre has drawn it: the card may still be a placeholder, its patch still
 * loading, or the line far down a long diff Pierre has not drawn yet, so
 * this jumps near the line's row first. Stops after about four seconds, or
 * when `live` says a newer reveal took over. Reads geometry only on the
 * reader's action.
 */
function chaseAnnotation(
  item: ReviewItem,
  column: Column,
  scroller: RefObject<HTMLElement | null>,
  store: PatchStore,
  live: () => boolean,
): void {
  const file = item.anchor.path;
  let frames = 0;
  let estimated = false;
  const step = () => {
    if (!live() || ++frames > 240) return;
    const card = column.cards.get(file);
    const box = scroller.current;
    if (card && box) {
      const target = [...card.querySelectorAll("[data-sc-anchor]")].find(
        (element) => element.getAttribute("data-sc-anchor") === item.id,
      );
      // An annotation Pierre has not drawn into its slot has no box yet.
      if (target && target.getClientRects().length > 0) {
        const offset = target.getBoundingClientRect().top - box.getBoundingClientRect().top;
        box.scrollTo({ top: box.scrollTop + offset - Math.round(box.clientHeight / 4) });
        return;
      }
      const patch = store.get(file);
      if (!estimated && patch?.state === "ready" && patch.file && item.anchor.line !== null) {
        estimated = true;
        const row = patchLinesOf(patch.file).rows.get(
          lineKey(annotationSide(item.anchor), item.anchor.line),
        );
        if (row !== undefined) {
          const top = card.getBoundingClientRect().top - box.getBoundingClientRect().top;
          box.scrollTo({ top: box.scrollTop + top + 36 + row * 20 - box.clientHeight / 3 });
        }
      }
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** The Change's review by file, for the Files tab; none for a commit's files. */
function useFileReviews(annotate: boolean, changeKey: ChangeKey, head: string) {
  const { stable } = useChangeReview(annotate ? changeKey : null);
  const writes = useReviewActions(changeKey);
  const [fileReviews] = useState(() => new FileReviewInterner());
  const byPath = useMemo(
    () => (annotate ? fileReviews.build(stable, head) : null),
    [annotate, fileReviews, stable, head],
  );
  return { byPath, actions: annotate ? writes : null };
}

/** Answers the rail's picks while this column can show them: the card is picked, then its annotation chased. */
function useAttachReveal({
  annotate,
  files,
  pick,
  column,
  scroller,
  store,
}: {
  annotate: boolean;
  files: readonly ChangeFile[] | null;
  /** Opens a file's card and scrolls to it, as a pick in the tree does. */
  pick: (path: string) => void;
  column: Column;
  scroller: RefObject<HTMLElement | null>;
  store: PatchStore;
}) {
  const focus = useContext(FocusContext);
  const chase = useRef(0);
  useEffect(() => {
    if (!focus || !annotate || !files) return;
    return focus.attach((item) => {
      if (!files.some((entry) => entry.path === item.anchor.path)) return;
      pick(item.anchor.path);
      const token = ++chase.current;
      chaseAnnotation(item, column, scroller, store, () => token === chase.current);
    });
  }, [focus, annotate, files, pick, column, scroller, store]);
}

// ── The view ───────────────────────────────────────────────────────────

/**
 * The column Pierre virtualizes against. Its size and scroll come from the
 * virtualizer's own observers; nothing is measured on mount.
 */
function DiffColumn({
  scroller,
  children,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const [virtualizer] = useState(() => new Virtualizer());
  useLayoutEffect(() => {
    const element = scroller.current;
    // Pierre observes the column with both; an engine without them (tests) draws diffs unvirtualized.
    if (
      !element ||
      typeof IntersectionObserver === "undefined" ||
      typeof ResizeObserver === "undefined"
    )
      return;
    // The diffs mounted before this ran wait in its queue until now.
    virtualizer.setup(element);
    return () => virtualizer.cleanUp();
  }, [virtualizer, scroller]);
  return (
    <VirtualizerContext.Provider value={virtualizer}>
      <div
        ref={scroller}
        data-testid="sc-diff-column"
        className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain"
      >
        {/* One child: the virtualizer reads the page's height off the first. */}
        <div>{children}</div>
      </div>
    </VirtualizerContext.Provider>
  );
}

export function FilesView({
  changeKey,
  revision,
  path,
  line,
  onPath,
  lead,
  showTree,
  annotate = false,
}: {
  changeKey: ChangeKey;
  revision: ReviewRevision;
  /** Draw the Change's review items and drafts on its lines (the Files tab, not a commit's files). */
  annotate?: boolean;
  /** The file the link names, scrolled to once the files are known. */
  path: string | null;
  line: number | null;
  /** The reader picked a file in the tree. */
  onPath: (path: string) => void;
  /** Drawn above the cards, inside the scrolling column (the rail on a narrow page). */
  lead?: ReactNode;
  showTree: boolean;
}) {
  const query = useRpcQuery({
    contract: sourceControlContract,
    method: "changeFiles",
    input: { key: changeKey, revision },
  });
  const answer = query.data;
  const files = useMemo(() => (answer?.ok ? readingOrder(answer.files) : null), [answer]);
  const store = usePatchStore(changeKey, revision);
  const [openState, setOpenState] = useState<Readonly<Record<string, boolean>>>({});
  const toggle = useCallback(
    (file: string) =>
      setOpenState((state) => ({ ...state, [file]: !(state[file] ?? !startsCollapsed(file)) })),
    [],
  );
  const [current, setCurrent] = useState<string | null>(path);
  const scroller = useRef<HTMLDivElement>(null);
  const column = useColumn(scroller, setCurrent);
  const reveal = useCallback(
    (file: string) => {
      setOpenState((state) => ({ ...state, [file]: true }));
      setCurrent(file);
      // On the reader's action, after the card has opened.
      // Only the diff column scrolls: `scrollIntoView` would also scroll bb's page around it.
      requestAnimationFrame(() => {
        const card = column.cards.get(file);
        const box = scroller.current;
        if (!card || !box) return;
        const offset = card.getBoundingClientRect().top - box.getBoundingClientRect().top;
        box.scrollTo({ top: box.scrollTop + offset });
      });
    },
    [column],
  );
  // A link naming a file scrolls to it once the files are known, and again on back/forward.
  const revealed = useRef<string | null>(null);
  const known = files !== null;
  useEffect(() => {
    if (!known || !path || revealed.current === path) return;
    revealed.current = path;
    reveal(path);
  }, [known, path, reveal]);
  const pick = useCallback(
    (file: string) => {
      revealed.current = file;
      reveal(file);
      onPath(file);
    },
    [onPath, reveal],
  );

  const { byPath, actions } = useFileReviews(annotate, changeKey, revision.head);
  // A rail row scrolls the diff to its item: the card first, then the item once its patch draws.
  useAttachReveal({ annotate, files, pick, column, scroller, store });

  let cards: ReactNode;
  if (answer === undefined)
    cards = query.error ? (
      <PatchesProblem text={query.error.message} onRetry={() => void query.refetch()} />
    ) : (
      <FileRowsSkeleton rows={6} label="Loading files…" />
    );
  else if (!answer.ok)
    cards = (
      <PatchesProblem text={describeProblem(answer.problem)} onRetry={() => void query.refetch()} />
    );
  else if (files!.length === 0)
    cards = (
      <p className="m-0 py-6 text-[13px] leading-5 text-muted-foreground">
        This change has no file changes.
      </p>
    );
  else
    cards = (
      <div className="flex min-w-0 flex-col gap-2">
        {files!.map((file, index) => (
          <FileCard
            key={file.path}
            eager={index < EAGER_CARDS}
            file={file}
            open={openState[file.path] ?? !startsCollapsed(file.path)}
            store={store}
            line={file.path === path ? line : null}
            onToggle={toggle}
            review={byPath?.get(file.path)}
            actions={actions}
            head={revision.head}
          />
        ))}
        {answer.more ? (
          <p className="m-0 text-[12px] leading-4 text-muted-foreground">
            More files than bb lists here. Open the pull request on GitHub for the rest.
          </p>
        ) : null}
      </div>
    );

  return (
    <ColumnContext.Provider value={column}>
      <div className="flex min-h-0 min-w-0 flex-1" data-testid="sc-files">
        {showTree ? (
          <aside
            aria-label={files ? plural(files.length, "file") : "Files"}
            className="flex w-68 shrink-0 flex-col overflow-y-auto overscroll-contain border-e border-solid border-border-hairline"
          >
            {files ? (
              <FileTree files={files} current={current} onSelect={pick} />
            ) : (
              <FileRowsSkeleton rows={8} label="Loading files…" />
            )}
          </aside>
        ) : null}
        <DiffColumn scroller={scroller}>
          <div className="flex min-w-0 flex-col gap-4 px-4 py-4 @3xl:px-6">
            {lead}
            {cards}
          </div>
        </DiffColumn>
      </div>
    </ColumnContext.Provider>
  );
}
