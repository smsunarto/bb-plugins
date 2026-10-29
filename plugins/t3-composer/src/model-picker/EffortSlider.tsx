// Codex's effort slider: the level's name above a pill track whose white fill
// runs to a round thumb, with a dot at each stop. Drag or tap a stop, with a
// haptic tick at each; the level applies on release. The desktop menu's header
// also holds a reset button beside the name.
import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { isLastInputKeyboard } from "@/components/ui/overlay-trigger";
import { cn } from "@/lib/utils";
import { selectionHaptic } from "./haptics";
import type { TraitOption } from "./traits";

export function EffortSlider(props: {
  options: readonly TraitOption[];
  current: string | null;
  /** The phone sheet's larger slider; the desktop menu's is smaller. */
  large: boolean;
  /** Take focus on mount, after the menu places its own, when the menu was opened from the keyboard. */
  focusFromKeyboard?: boolean;
  onChange(id: string): void | Promise<unknown>;
  /** Beside the name, at the right: the desktop panel's reset button. */
  trailing?: ReactNode;
  /** In a menu, Up and Down leave the slider for the buttons above it. */
  onArrowUpDown?(): void;
}) {
  const { options, large, focusFromKeyboard } = props;
  const trackRef = useRef<HTMLDivElement>(null);
  const attachTrack = useCallback(
    (node: HTMLDivElement | null) => {
      trackRef.current = node;
      if (!node || !focusFromKeyboard) return;
      // Read at mount, not render: a pointer open leaves focus, and no ring, on the menu.
      const frame = requestAnimationFrame(() => {
        if (isLastInputKeyboard()) node.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    },
    [focusFromKeyboard],
  );
  // The stop under the finger while dragging, then the applied pick until BB settles it.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const dragPointer = useRef<number | null>(null);
  // Only the latest pick may clear the pending stop; an earlier one settling must not.
  const latestCommit = useRef(0);

  const currentIndex = options.findIndex((option) => option.id === (pendingId ?? props.current));
  const index = dragIndex ?? (currentIndex === -1 ? null : currentIndex);
  const active = index === null ? null : options[index];
  const last = options.length - 1;
  // The thumb's radius: stops run from one end's thumb centre to the other's.
  const size = large ? SHEET : MENU;
  const radius = size.thumb / 2;
  const fraction = (stop: number) => (last === 0 ? 0 : stop / last);
  const stopLeft = (stop: number) =>
    `calc(${radius}px + (100% - ${2 * radius}px) * ${fraction(stop)})`;

  const indexAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    const span = (rect?.width ?? 0) - 2 * radius;
    if (!rect || span <= 0) return index ?? 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left - radius) / span));
    return Math.round(ratio * last);
  };

  const moveTo = (next: number) => {
    if (next !== index) selectionHaptic();
    setDragIndex(next);
  };

  const commit = (next: number) => {
    setDragIndex(null);
    const option = options[next];
    if (!option || next === currentIndex) return;
    const pick = ++latestCommit.current;
    setPendingId(option.id);
    void Promise.resolve(props.onChange(option.id)).finally(() => {
      if (pick === latestCommit.current) setPendingId(null);
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // A second finger leaves the drag in progress alone.
    if (event.button !== 0 || dragPointer.current !== null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragPointer.current = event.pointerId;
    moveTo(indexAt(event.clientX));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPointer.current !== event.pointerId) return;
    moveTo(indexAt(event.clientX));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPointer.current !== event.pointerId) return;
    dragPointer.current = null;
    commit(indexAt(event.clientX));
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPointer.current !== event.pointerId) return;
    dragPointer.current = null;
    setDragIndex(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // In a menu, Up and Down move between the slider and the buttons instead.
    if (props.onArrowUpDown && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      props.onArrowUpDown();
      return;
    }
    const from = index ?? 0;
    const next = keyStop(event.key, from, last);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (next !== from) selectionHaptic();
    commit(next);
  };

  const label = (
    <span
      aria-hidden
      className={cn("min-w-0 truncate text-center font-semibold text-foreground", size.label)}
    >
      {active?.label ?? "Choose effort"}
    </span>
  );

  return (
    <div data-t3-effort-slider="" className={size.root}>
      {large ? (
        label
      ) : (
        <div className="grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-1">
          <span aria-hidden />
          {label}
          <span className="flex justify-end">{props.trailing}</span>
        </div>
      )}
      <div className={size.frame}>
        <div
          ref={attachTrack}
          // A native range input on iOS ignores a tap on the track.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="slider"
          tabIndex={0}
          aria-label="Effort"
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={index ?? 0}
          aria-valuetext={active?.label}
          data-dragging={dragIndex !== null ? "" : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onPointerCancel}
          onKeyDown={onKeyDown}
          className="relative cursor-pointer touch-none select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          style={{ height: size.thumb } satisfies CSSProperties}
        >
          <div
            className={cn("absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-full", size.groove)}
            style={{ height: size.bar }}
          />
          {index === null ? null : (
            <div
              data-t3-effort-fill=""
              className="absolute left-0 top-1/2 -translate-y-1/2 rounded-full bg-foreground transition-[width] duration-150 ease-out motion-reduce:transition-none"
              style={{
                height: size.bar,
                width: `calc(${2 * radius}px + (100% - ${2 * radius}px) * ${fraction(index)})`,
              }}
            />
          )}
          {options.map((option, stop) => (
            <span
              key={option.id}
              aria-hidden
              className={cn(
                "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-150",
                size.dot,
                index !== null && stop <= index ? "bg-background/25" : "bg-foreground/30",
              )}
              style={{ left: stopLeft(stop) }}
            />
          ))}
          {index === null ? null : (
            <span
              data-t3-effort-thumb=""
              aria-hidden
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-[0_1px_6px_rgb(0_0_0/0.35)] ring-1 ring-black/5 transition-[left,scale] duration-150 ease-out motion-reduce:transition-none in-data-dragging:scale-110"
              style={{ left: stopLeft(index), width: size.knob, height: size.knob }}
            />
          )}
        </div>
      </div>
      {large && active?.description ? (
        <p className="min-h-8 max-w-full text-pretty text-center text-xs text-muted-foreground">
          {active.description}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The phone sheet's slider sits in a bordered well with the thumb inside its fill;
 * the desktop menu's, like Codex's, is a bare bar the thumb overhangs.
 */
const SHEET = {
  root: "flex flex-col items-center gap-4 px-2 pb-3 pt-2",
  label: "max-w-full text-xl",
  frame: "w-full rounded-full border border-border bg-foreground/[0.04] p-2 shadow-inner",
  groove: "",
  thumb: 44,
  bar: 44,
  knob: 36,
  dot: "size-2.5",
};
const MENU = {
  root: "flex w-64 flex-col gap-3 px-1.5 pb-2 pt-1",
  label: "text-base",
  frame: "w-full",
  groove: "bg-foreground/10",
  thumb: 30,
  bar: 26,
  knob: 30,
  dot: "size-1.5",
};

/** The stop a slider key moves to, or null for keys the slider leaves alone. */
function keyStop(key: string, from: number, last: number) {
  if (key === "ArrowRight" || key === "ArrowUp") return Math.min(last, from + 1);
  if (key === "ArrowLeft" || key === "ArrowDown") return Math.max(0, from - 1);
  if (key === "Home") return 0;
  if (key === "End") return last;
  return null;
}
