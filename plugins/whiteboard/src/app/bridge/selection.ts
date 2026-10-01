import type {
  ReviewDiffSide,
  ReviewDisposable,
  ReviewSourcePins,
  ReviewSurfaceEvent,
} from "../../shared/vendor/review-protocol/src/index.ts";
import type { SurfaceEvents } from "./events.ts";
import type { AlignedRow } from "./two-side.ts";

type SelectionEvent = Extract<ReviewSurfaceEvent, { event: "editorSelectionChanged" }>;
type SelectedDiff = NonNullable<SelectionEvent["selectedDiff"]>;

/** `@pierre/diffs` `SelectedLineRange`: line numbers on the `deletions` (base) or `additions` (head) side. */
export interface PierreLineRange {
  start: number;
  end: number;
  side?: "deletions" | "additions";
  endSide?: "deletions" | "additions";
}

/** What one rendered file offers a selection: its two sides and their alignment. */
export interface SelectionSurface {
  /** The base side's file, `null` when the base side does not exist. */
  basePath: string | null;
  headPath: string | null;
  rows: readonly AlignedRow[];
  base: readonly string[];
  head: readonly string[];
}

/** The comparison a selection was read at (`apiSource`, `reviewApiSelection.ts`). */
export interface SelectionSource {
  reviewId: string;
  version?: number;
  commit?: string;
  /** A source at its own pins says so; one that inherits carries no pins. */
  pins?: ReviewSourcePins;
}

const toSide = (side: PierreLineRange["side"]): ReviewDiffSide =>
  side === "deletions" ? "base" : "head";

/** A pierre range as one side's 1-based `[fromLine, toLine]`. A range that crosses sides keeps its start side. */
export function selectionRange(
  surface: Pick<SelectionSurface, "rows">,
  range: PierreLineRange,
): { side: ReviewDiffSide; fromLine: number; toLine: number } {
  const side = toSide(range.side);
  let end = range.end;

  if (range.endSide && toSide(range.endSide) !== side) {
    // Project the end line onto the start side through the nearest row that has one.
    const other = toSide(range.endSide);
    const index = surface.rows.findIndex(
      (row) => (other === "base" ? row.base : row.head) === range.end - 1,
    );
    let projected: number | null = null;

    for (let cursor = index; cursor >= 0 && projected === null; cursor--)
      projected = side === "base" ? surface.rows[cursor].base : surface.rows[cursor].head;
    end = projected === null ? range.start : projected + 1;
  }

  return {
    side,
    fromLine: Math.min(range.start, end),
    toLine: Math.max(range.start, end),
  };
}

/**
 * Port of Desktop `selectedMonacoDiff` (`reviewDiffSelection.ts`) over
 * alignment rows: the selected lines as a real diff excerpt. A change the
 * selection intersects is expanded to both sides; a one-sided change belongs
 * only when the selection crosses its insertion point.
 */
export function selectedDiff(
  surface: SelectionSurface,
  side: ReviewDiffSide,
  from: number,
  to: number,
): SelectedDiff | undefined {
  const { rows, base, head } = surface;
  const result: SelectedDiff = {
    oldPath: surface.basePath ?? "",
    newPath: surface.headPath ?? "",
    oldStart: 0,
    newStart: 0,
    rows: [],
  };
  const begin = (oldStart: number, newStart: number) => {
    if (!result.rows.length) {
      result.oldStart = oldStart;
      result.newStart = newStart;
    }
  };
  // 1-based cursors: the next line on each side.
  let oldLine = 1;
  let newLine = 1;

  for (let index = 0; index < rows.length;) {
    const row = rows[index];

    if (!row.changed) {
      const line = side === "base" ? oldLine : newLine;

      if (line >= from && line <= to) {
        begin(oldLine, newLine);
        result.rows.push({ kind: "unchanged", text: base[row.base!] });
      }
      oldLine++;
      newLine++;
      index++;
      continue;
    }
    const deleted: number[] = [];
    const added: number[] = [];

    while (index < rows.length && rows[index].changed) {
      if (rows[index].base !== null) deleted.push(rows[index].base! + 1);

      if (rows[index].head !== null) added.push(rows[index].head! + 1);
      index++;
    }
    const oldStart = oldLine;
    const newStart = newLine;
    const oldCount = deleted.length;
    const newCount = added.length;
    const start = side === "base" ? oldStart : newStart;
    const count = side === "base" ? oldCount : newCount;

    if (count ? from <= start + count - 1 && to >= start : from < start && to >= start) {
      const oldFrom = !newCount && side === "base" ? Math.max(oldStart, from) : oldStart;
      const oldTo =
        !newCount && side === "base" ? Math.min(oldStart + oldCount, to + 1) : oldStart + oldCount;
      const newFrom = !oldCount && side === "head" ? Math.max(newStart, from) : newStart;
      const newTo =
        !oldCount && side === "head" ? Math.min(newStart + newCount, to + 1) : newStart + newCount;

      begin(oldCount ? oldFrom : oldStart - 1, newCount ? newFrom : newStart - 1);

      for (let line = oldFrom; line < oldTo; line++)
        result.rows.push({ kind: "deleted", text: base[line - 1] });

      for (let line = newFrom; line < newTo; line++)
        result.rows.push({ kind: "added", text: head[line - 1] });
    }
    oldLine = oldStart + oldCount;
    newLine = newStart + newCount;
  }

  return result.rows.length ? result : undefined;
}

/**
 * Emit `editorSelectionChanged` from a code surface (design §3.8), which
 * feeds "Copy for agent" (`agent-selection.tsx`). `@pierre/diffs` reports
 * line selections (gutter click or drag) through `onLineSelected`; the
 * returned `select` adapts them. The anchor is the last pointer position
 * inside `root`, where the copy action appears.
 */
export function trackSelection(input: {
  root: HTMLElement;
  events: SurfaceEvents;
  reviewId?: string;
  source(): SelectionSource | undefined;
}): ReviewDisposable & {
  select(surface: SelectionSurface, range: PierreLineRange | null): void;
} {
  let anchor: { x: number; y: number } | undefined;
  let last: SelectionEvent | undefined;
  let disposed = false;
  const onPointer = (event: PointerEvent | MouseEvent) => {
    anchor = { x: event.clientX, y: event.clientY };
  };

  input.root.addEventListener("pointerup", onPointer);
  input.root.addEventListener("mouseup", onPointer);

  return {
    select(surface, range) {
      if (disposed || !input.reviewId) return;

      if (!range) {
        if (last && !last.isEmpty) {
          last = { ...last, isEmpty: true, selectedDiff: undefined };
          input.events.emit(withoutUndefined(last));
        }

        return;
      }
      const { side, fromLine, toLine } = selectionRange(surface, range);
      const path = side === "base" ? surface.basePath : surface.headPath;

      if (!path) return;
      const source = input.source();
      const event: SelectionEvent = {
        event: "editorSelectionChanged",
        reviewId: input.reviewId,
        anchor,
        path,
        sideContext: side,
        isEmpty: false,
        range: { fromLine, toLine },
        selectedDiff: selectedDiff(surface, side, fromLine, toLine),
        apiSource:
          source?.version === undefined
            ? undefined
            : withoutUndefined({
                reviewId: source.reviewId,
                version: source.version,
                commit: source.commit,
                pins: source.pins,
              }),
      };

      last = event;
      input.events.emit(withoutUndefined(event));
    },
    dispose() {
      disposed = true;
      input.root.removeEventListener("pointerup", onPointer);
      input.root.removeEventListener("mouseup", onPointer);
    },
  };
}

/** The wire schemas are strict objects; leave absent keys out instead of `undefined`. */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
