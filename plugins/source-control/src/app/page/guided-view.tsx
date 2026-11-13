/**
 * The Guided tab (boards A and E): the Change's files in the guide's reading
 * order, with the outline, the summary, each group's intro, a note per file
 * and the viewed boxes. It draws the derived order at once and lays the
 * guide over it when the read lands, through the Files tab's own column and
 * cards: one virtualized diff renderer for both tabs.
 *
 * Cards are keyed by path and are siblings of the group intros in one list,
 * so a regroup (the guide landing, a new head) moves them without
 * remounting: open and collapsed state, an open composer's text and focus
 * stay, and the file being read keeps its place in the column.
 */
import { experimental_useRpcQuery as useRpcQuery } from "@get-bb/plugin-sdk/app";
import {
  Component,
  memo,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { describeProblem, type Problem } from "../../core/change.ts";
import {
  CHANGED_GROUP,
  UNGUIDED_GROUP,
  resolveGuide,
  viewedAtHead,
  type Guide,
  type GuideView,
  type ResolvedFile,
  type ResolvedGuide,
} from "../../core/guide.ts";
import type { ChangeKey } from "../../core/ids.ts";
import type { ReviewItem } from "../../core/items.ts";
import type { ChangeFile, ReviewRevision } from "../../core/review.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import { FileRowsSkeleton, PatchesProblem } from "../file-cards.tsx";
import { Button } from "../components/ui/button.tsx";
import { cx, plural } from "../format.ts";
import { useGuide, useRewriteGuide, type GuideRead, type Rewrite } from "../guide-data.ts";
import { useChangeReview } from "../review-data.ts";
import { ViewerContext } from "../review-ui.tsx";
import {
  ColumnContext,
  DiffColumn,
  EAGER_CARDS,
  FileCard,
  isOpen,
  useAttachReveal,
  useColumn,
  useFileReviews,
  useOpenState,
  useRevealFile,
  useViewed,
  type Column,
} from "./files-view.tsx";
import { Chevron } from "./icons.tsx";
import { usePatchStore } from "./patches.ts";
import { FocusContext } from "./review-focus.ts";

const LABEL =
  "m-0 text-[11px] leading-4 font-normal tracking-[0.06em] text-(--tertiary-foreground) uppercase";
const LINK =
  "shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[12px] leading-4 font-medium whitespace-nowrap text-foreground underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-60";

// ── The file being read ────────────────────────────────────────────────

/** The column's current file, outside React state: scrolling redraws only what subscribes. */
class Reading {
  private path: string | null;
  private readonly listeners = new Set<() => void>();

  constructor(path: string | null) {
    this.path = path;
  }

  get = (): string | null => this.path;

  set = (path: string): void => {
    if (path === this.path) return;
    this.path = path;
    for (const listener of this.listeners) listener();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

// ── The order ──────────────────────────────────────────────────────────

const FILE_FIELDS = [
  "path",
  "kind",
  "previousPath",
  "additions",
  "deletions",
  "binary",
  "blob",
  "note",
] as const satisfies readonly (keyof ResolvedFile)[];

const sameFile = (a: ResolvedFile, b: ResolvedFile) =>
  FILE_FIELDS.every((field) => a[field] === b[field]);

/**
 * `resolveGuide` with each file's object kept while it is unchanged, so a
 * read that brings the same guide again (every viewed tick marks the tag
 * stale) redraws no card.
 */
class GuideInterner {
  private files = new Map<string, ResolvedFile>();

  resolve(guide: Guide | null, files: readonly ChangeFile[], head: string): ResolvedGuide {
    const next = resolveGuide(guide, files, head);
    const kept = new Map<string, ResolvedFile>();
    const groups = next.groups.map((group) => ({
      ...group,
      files: group.files.map((file) => {
        const old = this.files.get(file.path);
        const same = old && sameFile(old, file) ? old : file;
        kept.set(file.path, same);
        return same;
      }),
    }));
    this.files = kept;
    return { ...next, groups };
  }
}

type Row =
  | { kind: "group"; id: string; index: number; title: string; intro: string | null }
  | { kind: "file"; file: ResolvedFile; index: number };

/** Lines under the derived groups a guide adds, which have no intro of their own. */
const DERIVED_INTRO: Record<string, string> = {
  [CHANGED_GROUP]: "These files changed after bb wrote the guide.",
  [UNGUIDED_GROUP]: "The guide doesn't mention these files.",
};

function rowsOf(resolved: ResolvedGuide): Row[] {
  const rows: Row[] = [];
  let index = 0;
  resolved.groups.forEach((group, at) => {
    rows.push({
      kind: "group",
      id: group.id,
      index: at,
      title: group.title,
      intro: group.intro || DERIVED_INTRO[group.id] || null,
    });
    for (const file of group.files) rows.push({ kind: "file", file, index: index++ });
  });
  return rows;
}

const rowKey = (row: Row) => (row.kind === "group" ? `group:${row.id}` : row.file.path);

// ── Status ─────────────────────────────────────────────────────────────

function problemText(problem: Problem): string {
  return problem.kind === "failed" ? problem.detail : describeProblem(problem);
}

type Status = {
  text: string;
  action: "refetch" | "rewrite" | null;
  label: string;
  warning: boolean;
};

const UNTIL = " Files are in path order until then.";

/** One plain sentence on the guide's state, and the action that moves it on; null when all is well. */
function statusOf(
  view: GuideView | undefined,
  error: string | null,
  source: ResolvedGuide["source"],
): Status | null {
  if (!view)
    return error
      ? {
          text: `Couldn't read the guide. ${error}`,
          action: "refetch",
          label: "Try again",
          warning: true,
        }
      : null;
  const why = view.problem ? ` ${problemText(view.problem)}` : "";
  switch (view.phase) {
    case "waiting":
      return {
        text: view.guide ? "Waiting to rewrite the guide." : `Waiting to write the guide.${UNTIL}`,
        action: null,
        label: "",
        warning: false,
      };
    case "writing":
      // A rewrite keeps the guide it replaces on show until the new one lands.
      return view.guide
        ? { text: "bb is rewriting the guide.", action: null, label: "", warning: false }
        : { text: `bb is writing the guide.${UNTIL}`, action: null, label: "", warning: false };
    case "failed":
      return {
        text: `bb couldn't write the guide.${why}`,
        action: "rewrite",
        label: "Try again",
        warning: true,
      };
    case "none":
      return view.problem
        ? {
            text: `bb can't write a guide for this change.${why} Files stay in path order.`,
            action: null,
            label: "",
            warning: false,
          }
        : null;
    case "done":
      return source === "carried"
        ? {
            text: "The guide was written for an earlier commit.",
            action: "rewrite",
            label: "Rewrite guide",
            warning: false,
          }
        : null;
  }
}

function GuideStatus({
  read,
  source,
  rewrite,
}: {
  read: GuideRead;
  source: ResolvedGuide["source"];
  rewrite: Rewrite;
}) {
  const status = statusOf(read.view, read.error, source);
  if (!status) return null;
  const run = status.action === "refetch" ? read.refetch : rewrite.rewrite;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
      data-testid="sc-guide-status"
      data-phase={read.view?.phase ?? "unread"}
      role={status.warning ? "alert" : "status"}
    >
      <p
        className={cx(
          "m-0 min-w-0 text-[12px] leading-4",
          status.warning ? "text-warning" : "text-muted-foreground",
        )}
      >
        {status.text}
      </p>
      {status.action ? (
        <button
          type="button"
          className={LINK}
          disabled={rewrite.pending}
          data-testid="sc-guide-action"
          onClick={run}
        >
          {rewrite.pending ? "Starting…" : status.label}
        </button>
      ) : null}
      {rewrite.error ? (
        <span role="alert" className="min-w-0 text-[12px] leading-4 text-warning">
          {rewrite.error}
        </span>
      ) : null}
    </div>
  );
}

function Sparkle() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0 text-primary">
      <path
        d="M6 1L7.2 4.8L11 6L7.2 7.2L6 11L4.8 7.2L1 6L4.8 4.8L6 1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "Summary · written by bb" (board A). */
function SummaryCard({ summary }: { summary: string }) {
  return (
    <section
      aria-label="Summary"
      data-testid="sc-guide-summary"
      className="flex min-w-0 flex-col gap-2 rounded-[8px] border border-solid border-border bg-surface-recessed p-3"
    >
      <div className="flex items-center gap-2">
        <Sparkle />
        <h2 className={LABEL}>Summary · written by bb</h2>
      </div>
      <p className="m-0 text-[13px] leading-5 whitespace-pre-line text-foreground">{summary}</p>
    </section>
  );
}

// ── Group intros ───────────────────────────────────────────────────────

/** "2 of 5 · title" and the intro (board A); larger, with "read this first", on a phone (board E). */
const GroupIntro = memo(function GroupIntro({
  id,
  index,
  total,
  title,
  intro,
  first,
  phone,
  register,
}: {
  id: string;
  index: number;
  total: number;
  title: string;
  intro: string | null;
  /** The first group with files left to view. */
  first: boolean;
  phone: boolean;
  register: (id: string, element: HTMLElement | null) => void;
}) {
  const ref = useCallback((element: HTMLElement | null) => register(id, element), [register, id]);
  return (
    <header
      ref={ref}
      data-testid="sc-guide-group"
      data-group={id}
      className="mt-2 mb-2 flex min-w-0 flex-col gap-2 pt-1 first:mt-0"
    >
      {phone ? (
        <>
          <span className="font-mono text-[12px] leading-4 text-(--tertiary-foreground)">
            {index + 1} of {total}
            {first ? " · read this first" : null}
          </span>
          <h2 className="m-0 text-[19px] leading-6 font-semibold tracking-[-0.01em] text-foreground">
            {title}
          </h2>
        </>
      ) : (
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-[12px] leading-6 text-(--tertiary-foreground)">
            {index + 1} of {total}
          </span>
          <h2 className="m-0 min-w-0 text-[16px] leading-6 font-semibold text-foreground">
            {title}
          </h2>
        </div>
      )}
      {intro ? (
        <p
          className={cx(
            "m-0 max-w-176.75 text-muted-foreground",
            phone ? "text-[15px] leading-6" : "text-[13px] leading-5",
          )}
        >
          {intro}
        </p>
      ) : null}
    </header>
  );
});

// ── Outline ────────────────────────────────────────────────────────────

type Findings = { count: number; top: number };

/** Open findings per group: how many, and the most urgent priority. */
function findingsByGroup(
  items: readonly ReviewItem[],
  groupOf: ReadonlyMap<string, string>,
): Map<string, Findings> {
  const out = new Map<string, Findings>();
  for (const item of items) {
    if (item.state !== "open" || item.priority === null) continue;
    const group = groupOf.get(item.anchor.path);
    if (!group) continue;
    const old = out.get(group);
    out.set(group, {
      count: (old?.count ?? 0) + 1,
      top: Math.min(old?.top ?? item.priority, item.priority),
    });
  }
  return out;
}

const DOT = ["bg-destructive", "bg-warning"] as const;

const OutlineRow = memo(function OutlineRow({
  id,
  index,
  title,
  files,
  done,
  current,
  findings,
  onPick,
}: {
  id: string;
  index: number;
  title: string;
  files: number;
  done: boolean;
  current: boolean;
  findings: Findings | undefined;
  onPick: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={current ? "location" : undefined}
        data-testid="sc-outline-row"
        data-group={id}
        onClick={() => onPick(id)}
        className={cx(
          "flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-[6px] border-0 p-2 text-start hover:bg-surface-raised",
          current ? "bg-border-hairline" : "bg-transparent",
        )}
      >
        <span
          className={cx(
            "w-4 shrink-0 font-mono text-[12px] leading-5",
            done ? "text-success" : current ? "text-foreground" : "text-(--tertiary-foreground)",
          )}
        >
          {done ? "✓" : index + 1}
          {done ? <span className="sr-only">Viewed</span> : null}
        </span>
        <span
          className={cx(
            "min-w-0 flex-1 text-[13px] leading-5",
            current
              ? "font-semibold text-foreground"
              : done
                ? "text-(--tertiary-foreground)"
                : "text-muted-foreground",
          )}
        >
          {title}
        </span>
        {findings ? (
          <span
            className="flex h-5 shrink-0 items-center gap-2"
            title={plural(findings.count, "finding")}
          >
            <span
              aria-hidden
              className={cx(
                "size-1.5 shrink-0 rounded-full",
                DOT[findings.top as 0 | 1] ?? "bg-(--tertiary-foreground)",
              )}
            />
            <span
              className={cx(
                "text-[12px] leading-4",
                current ? "text-muted-foreground" : "text-(--tertiary-foreground)",
              )}
            >
              {findings.count}
              <span className="sr-only"> findings</span>
            </span>
          </span>
        ) : (
          <span className="shrink-0 text-[12px] leading-5 text-(--tertiary-foreground)">
            {files}
            <span className="sr-only"> files</span>
          </span>
        )}
      </button>
    </li>
  );
});

/** "Read in this order" (board A): one row per group; only the current group's row follows the scroll. */
const Outline = memo(function Outline({
  resolved,
  viewed,
  groupOf,
  reading,
  findings,
  onPick,
}: {
  resolved: ResolvedGuide;
  viewed: ReadonlySet<string>;
  groupOf: ReadonlyMap<string, string>;
  reading: Reading;
  findings: ReadonlyMap<string, Findings>;
  onPick: (id: string) => void;
}) {
  const current = useSyncExternalStore(reading.subscribe, () => {
    const path = reading.get();
    return path === null ? null : (groupOf.get(path) ?? null);
  });
  return (
    <nav
      aria-label="Read in this order"
      data-testid="sc-guide-outline"
      className="flex w-68 shrink-0 flex-col gap-1 overflow-y-auto overscroll-contain border-e border-solid border-border-hairline py-5 ps-8 pe-3"
    >
      <h2 className={cx(LABEL, "px-2 pb-2")}>Read in this order</h2>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {resolved.groups.map((group, index) => (
          <OutlineRow
            key={group.id}
            id={group.id}
            index={index}
            title={group.title}
            files={group.files.length}
            done={group.files.every((file) => viewed.has(file.path))}
            current={group.id === current}
            findings={findings.get(group.id)}
            onPick={onPick}
          />
        ))}
      </ol>
    </nav>
  );
});

// ── Keeping the reader's place ─────────────────────────────────────────

type Place = {
  path: string | null;
  top: number | null;
  focus: { element: HTMLElement; start: number | null; end: number | null } | null;
};

function offsetIn(element: Element, box: Element): number {
  return element.getBoundingClientRect().top - box.getBoundingClientRect().top;
}

/**
 * Around the cards: when their order changes, the file being read stays
 * where it was in the column and focus stays where it was. Geometry is read
 * only on a reorder, never on mount or scroll.
 */
class KeepReading extends Component<{
  order: string;
  reading: Reading;
  column: Column;
  scroller: RefObject<HTMLElement | null>;
  children: ReactNode;
}> {
  override getSnapshotBeforeUpdate(previous: Readonly<{ order: string }>): Place | null {
    if (previous.order === this.props.order) return null;
    const box = this.props.scroller.current;
    if (!box) return null;
    const active = box.ownerDocument.activeElement;
    const focus =
      active instanceof HTMLElement && active !== box && box.contains(active)
        ? {
            element: active,
            start: "selectionStart" in active ? (active.selectionStart as number | null) : null,
            end: "selectionEnd" in active ? (active.selectionEnd as number | null) : null,
          }
        : null;
    const path = this.props.reading.get();
    const card = path ? this.props.column.cards.get(path) : undefined;
    return { path, top: card ? offsetIn(card, box) : null, focus };
  }

  override componentDidUpdate(_props: unknown, _state: unknown, place: Place | null): void {
    if (!place) return;
    const box = this.props.scroller.current;
    const card = place.path ? this.props.column.cards.get(place.path) : undefined;
    if (box && card && place.top !== null) {
      const moved = offsetIn(card, box) - place.top;
      if (moved !== 0) box.scrollTop += moved;
    }
    const { focus } = place;
    if (focus && focus.element.isConnected && box?.ownerDocument.activeElement !== focus.element) {
      focus.element.focus({ preventScroll: true });
      if (focus.start !== null && "setSelectionRange" in focus.element)
        (focus.element as HTMLTextAreaElement).setSelectionRange(focus.start, focus.end);
    }
  }

  override render() {
    return this.props.children;
  }
}

// ── Phone review bar ───────────────────────────────────────────────────

function Step({
  direction,
  onClick,
  label,
}: {
  direction: -1 | 1;
  onClick: () => void;
  label: string;
}) {
  return (
    <Button variant="ghost" aria-label={label} onClick={onClick} className="size-11 px-0">
      <Chevron className={direction < 0 ? "rotate-90" : "-rotate-90"} />
    </Button>
  );
}

/**
 * Board E's bottom bar: "‹ 1 of 4 ›" steps through the open review items in
 * reading order, revealing each in the diff, and the page's send controls.
 */
export function ReviewBar({
  changeKey,
  order,
  children,
}: {
  changeKey: ChangeKey;
  /** Each path's place in the reading order. */
  order: ReadonlyMap<string, number>;
  /** The send controls. */
  children: ReactNode;
}) {
  const { stable } = useChangeReview(changeKey);
  const focus = useContext(FocusContext);
  const items = useMemo(
    () =>
      stable.items
        .filter((item) => item.state === "open" && !stable.fixing.has(item.id))
        .toSorted(
          (a, b) =>
            (order.get(a.anchor.path) ?? Infinity) - (order.get(b.anchor.path) ?? Infinity) ||
            (a.anchor.line ?? 0) - (b.anchor.line ?? 0),
        ),
    [stable.items, stable.fixing, order],
  );
  const subscribe = useCallback(
    (listener: () => void) => focus?.subscribe(listener) ?? (() => {}),
    [focus],
  );
  const focused = useSyncExternalStore(subscribe, () => focus?.getFocused() ?? null);
  const at = items.findIndex((item) => item.id === focused);
  const go = (step: -1 | 1) => {
    if (items.length === 0) return;
    const next =
      at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
    focus?.reveal(items[next]!);
  };
  return (
    <div
      data-testid="sc-review-bar"
      className="flex shrink-0 items-center gap-2 border-t border-solid border-border-hairline bg-sidebar px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
    >
      {items.length > 0 ? (
        <div className="flex h-11 shrink-0 items-center rounded-[10px] border border-solid border-border">
          <Step direction={-1} label="Previous item" onClick={() => go(-1)} />
          <span
            className="px-1 text-[14px] leading-5 whitespace-pre text-foreground"
            data-testid="sc-review-bar-position"
          >
            {at < 0 ? plural(items.length, "item") : `${at + 1} of ${items.length}`}
          </span>
          <Step direction={1} label="Next item" onClick={() => go(1)} />
        </div>
      ) : null}
      <span className="min-w-0 flex-1" />
      {children}
    </div>
  );
}

// ── Progress ───────────────────────────────────────────────────────────

/** "5 of 14 viewed" and its bar, for the tab row (board A). Reads what the tabs already read. */
export const ViewedProgress = memo(function ViewedProgress({
  changeKey,
  revision,
}: {
  changeKey: ChangeKey;
  revision: ReviewRevision;
}) {
  const query = useRpcQuery({
    contract: sourceControlContract,
    method: "changeFiles",
    input: { key: changeKey, revision },
  });
  const files = query.data?.ok ? query.data.files : null;
  const { view } = useGuide(changeKey);
  const marks = view?.viewed;
  const count = useMemo(
    () => (files && marks ? viewedAtHead(files, marks).size : 0),
    [files, marks],
  );
  if (!files || files.length === 0 || !view) return null;
  const share = Math.round((count / files.length) * 100);
  return (
    <span className="flex shrink-0 items-center gap-2" data-testid="sc-viewed-progress">
      <span className="text-[12px] leading-4 text-(--tertiary-foreground)">
        {count} of {files.length} viewed
      </span>
      {/* The words say it; the bar only draws it. */}
      <span aria-hidden className="flex h-1 w-16 shrink-0 rounded-full bg-surface-raised">
        <span
          className="h-1 shrink-0 rounded-full bg-muted-foreground"
          style={{ width: `${share}%` }}
        />
      </span>
    </span>
  );
});

// ── The view ───────────────────────────────────────────────────────────

const NO_FILES: readonly ChangeFile[] = Object.freeze([]);

/** The reading order at this head, and the lookups the outline, the bar and the cards share. */
function useGuideOrder(guide: Guide | null, files: readonly ChangeFile[] | null, head: string) {
  const [interner] = useState(() => new GuideInterner());
  const resolved = useMemo(
    () => interner.resolve(guide, files ?? NO_FILES, head),
    [interner, guide, files, head],
  );
  return useMemo(() => {
    const rows = rowsOf(resolved);
    const groupOf = new Map<string, string>();
    const place = new Map<string, number>();
    for (const group of resolved.groups)
      for (const file of group.files) {
        groupOf.set(file.path, group.id);
        place.set(file.path, place.size);
      }
    return {
      resolved,
      rows,
      order: rows.map(rowKey).join("\n"),
      groupOf,
      place,
      ordered: resolved.groups.flatMap((group) => group.files),
    };
  }, [resolved]);
}

/** The group intros by id, and an outline pick that scrolls the column to one. */
function useGroupPick(
  resolved: ResolvedGuide,
  reading: Reading,
  scroller: RefObject<HTMLElement | null>,
  column: Column,
) {
  const intros = useRef(new Map<string, HTMLElement>());
  const register = useCallback((id: string, element: HTMLElement | null) => {
    if (element) intros.current.set(id, element);
    else intros.current.delete(id);
  }, []);
  const onPickGroup = useCallback(
    (id: string) => {
      const first = resolved.groups.find((group) => group.id === id)?.files[0];
      if (first) reading.set(first.path);
      // On the reader's action: scroll the column, never bb's page around it.
      const intro = intros.current.get(id);
      const box = scroller.current;
      if (!intro || !box) return;
      column.unpin();
      box.scrollTo({ top: box.scrollTop + offsetIn(intro, box) });
    },
    [resolved, reading, scroller, column],
  );
  return { register, onPickGroup };
}

type FilesAnswer = ReturnType<
  typeof useRpcQuery<typeof sourceControlContract, "changeFiles">
>["data"];

/** Before there are cards: loading, a failed read, or a change with no files. */
function FilesState({
  answer,
  error,
  retry,
}: {
  answer: FilesAnswer;
  error: string | null;
  retry: () => void;
}) {
  if (answer === undefined)
    return error ? (
      <PatchesProblem text={error} onRetry={retry} />
    ) : (
      <FileRowsSkeleton rows={6} label="Loading files…" />
    );
  if (!answer.ok) return <PatchesProblem text={describeProblem(answer.problem)} onRetry={retry} />;
  return (
    <p className="m-0 py-6 text-[13px] leading-5 text-muted-foreground">
      This change has no file changes.
    </p>
  );
}

export function GuidedView({
  changeKey,
  revision,
  path,
  line,
  onPath,
  lead,
  wide,
  phone,
  bar,
}: {
  changeKey: ChangeKey;
  revision: ReviewRevision;
  path: string | null;
  line: number | null;
  onPath: (path: string) => void;
  /** Drawn above the guide, inside the scrolling column (the rail on a narrow page). */
  lead?: ReactNode;
  /** Wide enough for the outline beside the column. */
  wide: boolean;
  /** Board E: larger group intros and the review bar under the column. */
  phone: boolean;
  /** The send controls, for the phone's review bar. */
  bar?: ReactNode;
}) {
  const query = useRpcQuery({
    contract: sourceControlContract,
    method: "changeFiles",
    input: { key: changeKey, revision },
  });
  const answer = query.data;
  const files = answer?.ok ? answer.files : null;
  // The derived order draws as soon as the files are known; the guide never holds it back.
  const read = useGuide(changeKey);
  const { resolved, rows, order, groupOf, place, ordered } = useGuideOrder(
    read.view?.guide ?? null,
    files,
    revision.head,
  );

  const store = usePatchStore(changeKey, revision);
  const { openState, toggle, setOpen } = useOpenState();
  const [reading] = useState(() => new Reading(path));
  const scroller = useRef<HTMLDivElement>(null);
  const column = useColumn(scroller, reading.set);
  const pick = useRevealFile({
    column,
    scroller,
    setOpen,
    onCurrent: reading.set,
    path,
    known: files !== null,
    onPath,
  });
  const viewed = useViewed(changeKey, files, setOpen);
  const { byPath, actions, viewer } = useFileReviews(true, changeKey, revision.head);
  useAttachReveal({ annotate: true, files: files ? ordered : null, pick, column, scroller, store });
  const rewrite = useRewriteGuide(changeKey);

  const { stable } = useChangeReview(changeKey);
  const findings = useMemo(() => findingsByGroup(stable.items, groupOf), [stable.items, groupOf]);
  const { register, onPickGroup } = useGroupPick(resolved, reading, scroller, column);
  const firstUnread = useMemo(
    () =>
      resolved.groups.find((group) => group.files.some((file) => !viewed.set.has(file.path)))?.id ??
      null,
    [resolved, viewed.set],
  );

  const body =
    !answer?.ok || answer.files.length === 0 ? (
      <FilesState
        answer={answer}
        error={query.error?.message ?? null}
        retry={() => void query.refetch()}
      />
    ) : (
      <KeepReading order={order} reading={reading} column={column} scroller={scroller}>
        {/* Intros and cards are siblings, so a regroup moves cards instead of remounting them. */}
        <div className="flex min-w-0 flex-col gap-2" data-testid="sc-guided-cards">
          {rows.map((row) =>
            row.kind === "group" ? (
              <GroupIntro
                key={rowKey(row)}
                id={row.id}
                index={row.index}
                total={resolved.groups.length}
                title={row.title}
                intro={row.intro}
                first={phone && row.id === firstUnread}
                phone={phone}
                register={register}
              />
            ) : (
              <FileCard
                key={row.file.path}
                eager={row.index < EAGER_CARDS}
                file={row.file}
                note={row.file.note}
                open={isOpen(openState, row.file.path)}
                store={store}
                line={row.file.path === path ? line : null}
                onToggle={toggle}
                review={byPath?.get(row.file.path)}
                actions={actions}
                head={revision.head}
                viewed={viewed.of(row.file)}
                onViewed={viewed.onViewed}
              />
            ),
          )}
          {answer.more ? (
            <p className="m-0 text-[12px] leading-4 text-muted-foreground">
              More files than bb lists here. Open the pull request on GitHub for the rest.
            </p>
          ) : null}
        </div>
      </KeepReading>
    );

  return (
    <ColumnContext.Provider value={column}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="sc-guided">
        <div className="flex min-h-0 min-w-0 flex-1">
          {wide && files ? (
            <Outline
              resolved={resolved}
              viewed={viewed.set}
              groupOf={groupOf}
              reading={reading}
              findings={findings}
              onPick={onPickGroup}
            />
          ) : null}
          <DiffColumn scroller={scroller}>
            <div
              className={cx(
                "flex min-w-0 flex-col gap-4",
                phone ? "px-5 py-3" : "px-4 py-4 @3xl:px-8 @3xl:py-6",
              )}
            >
              {lead}
              <GuideStatus read={read} source={resolved.source} rewrite={rewrite} />
              {resolved.summary ? <SummaryCard summary={resolved.summary} /> : null}
              <ViewerContext.Provider value={viewer}>{body}</ViewerContext.Provider>
            </div>
          </DiffColumn>
        </div>
        {phone ? (
          <ReviewBar changeKey={changeKey} order={place}>
            {bar}
          </ReviewBar>
        ) : null}
      </div>
    </ColumnContext.Provider>
  );
}
