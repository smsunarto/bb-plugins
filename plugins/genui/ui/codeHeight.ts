// The height BB's code viewer draws a block of code at, learned on this
// device. The viewer (experimental_SourceCode) shows a fixed skeleton while
// it highlights, then draws the code at a height set by its line count alone
// (lines never wrap: overflow "scroll"). A Code or Snippet body holds the
// height its line count will take while the file loads and the viewer
// highlights, so the card neither shrinks nor grows when the code arrives.
// Kept in localStorage: a fresh page has no highlighted code yet.
import { type RefObject, useLayoutEffect } from "react";

const STORAGE_KEY = "bb.genui.codeHeights";
/** Line counts remembered; longer blocks reach the frame's height cap anyway. */
const MAX_LINES = 40;
const PERSIST_MS = 500;

/** Body heights the viewer drew, by line count. */
export class CodeHeights {
  private readonly heights = new Map<number, number>();

  /** Records a drawn body; false when nothing changed. */
  record(lines: number, height: number): boolean {
    if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LINES || !(height > 0)) return false;
    const rounded = Math.round(height);
    if (this.heights.get(lines) === rounded) return false;
    this.heights.set(lines, rounded);
    return true;
  }

  /**
   * The height `lines` lines take in a body capped at `cap` px: as drawn
   * before, or on the line through the two nearest lengths drawn below the
   * cap. Null until two lengths are known.
   */
  predict(lines: number, cap: number): number | null {
    const drawn = this.heights.get(lines);
    if (drawn !== undefined) return Math.min(cap, drawn);
    const [near, next] = [...this.heights]
      .filter(([, height]) => height < cap)
      .sort(([a], [b]) => Math.abs(a - lines) - Math.abs(b - lines));
    if (next === undefined) return null;
    const perLine = (next[1] - near[1]) / (next[0] - near[0]);
    if (!(perLine > 0)) return null;
    return Math.min(cap, Math.round(near[1] + perLine * (lines - near[0])));
  }

  serialize(): string {
    return JSON.stringify([...this.heights]);
  }

  /** Entries from `serialize`; anything malformed is skipped. */
  static read(raw: string | null): CodeHeights {
    const store = new CodeHeights();
    let parsed: unknown = null;
    try {
      parsed = raw === null ? null : JSON.parse(raw);
    } catch {
      // A damaged copy is an empty one.
    }
    if (!Array.isArray(parsed)) return store;
    for (const item of parsed) {
      if (Array.isArray(item) && typeof item[0] === "number" && typeof item[1] === "number") store.record(item[0], item[1]);
    }
    return store;
  }
}

let shared: CodeHeights | null = null;
let persistTimer: number | undefined;

function heights(): CodeHeights {
  if (shared === null) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage unavailable: heights are learned again on each page.
    }
    shared = CodeHeights.read(raw);
  }
  return shared;
}

/**
 * Holds `body` (a Code or Snippet frame's body, `lines` lines long; null
 * when unknown) at the height the viewer will draw it at, then lets it
 * follow its content and learns what the viewer drew. The file's loading
 * rows and the viewer's skeleton both pulse (`animate-pulse`): a body without
 * one is drawn, so if BB's skeleton ever stops pulsing nothing is held.
 */
export function useCodeHeight(body: RefObject<HTMLDivElement | null>, lines: number | null): void {
  useLayoutEffect(() => {
    const box = body.current;
    if (box === null || lines === null) return;
    const store = heights();
    const loading = () => box.querySelector(".animate-pulse") !== null;
    const release = () => {
      box.style.height = "";
      box.style.overflow = "";
    };
    const cap = Number.parseFloat(getComputedStyle(box).maxHeight);
    const expected = loading() ? store.predict(lines, Number.isFinite(cap) ? cap : Number.POSITIVE_INFINITY) : null;
    if (expected !== null) {
      box.style.height = `${expected}px`;
      box.style.overflow = "hidden";
    }
    // A body held at a fixed height doesn't resize as its content changes: watch the content.
    const content = new MutationObserver(() => {
      if (!loading()) release();
    });
    // Only the viewer's own drawing (its diffs-container) teaches the height; a hidden tab measures 0.
    const drawn = new ResizeObserver(() => {
      if (box.style.height !== "" || loading() || box.querySelector("diffs-container") === null) return;
      if (!store.record(lines, box.offsetHeight)) return;
      persistTimer ??= window.setTimeout(() => {
        persistTimer = undefined;
        try {
          localStorage.setItem(STORAGE_KEY, store.serialize());
        } catch {
          // Storage full or unavailable: the heights hold for this page only.
        }
      }, PERSIST_MS);
    });
    content.observe(box, { childList: true, subtree: true });
    drawn.observe(box);
    return () => {
      content.disconnect();
      drawn.disconnect();
      release();
    };
  }, [body, lines]);
}
