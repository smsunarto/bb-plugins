// What Benchmark, Waterfall and Treemap share: the frame (a bordered panel on
// its own, flat inside a Card), the heading, quiet text buttons, a two-way
// segmented switch, links through the runtime, and the CSS grid lines of a
// shared axis.
import { useContext, type ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CardDepthContext, useUiRuntime } from "../runtime";
import { FADE, useEntrance } from "./motion";

/** The outermost component draws the frame; inside a Card it sits flat. */
export function Frame({ label, children }: { label: string; children: ReactNode }) {
  const depth = useContext(CardDepthContext);
  const fade = useEntrance<HTMLDivElement>(FADE);
  const body = (
    <div ref={fade} className="@container flex min-w-0 flex-col gap-3">
      {children}
    </div>
  );
  if (depth > 0) return <div aria-label={label} className="min-w-0 text-sm text-foreground">{body}</div>;
  return (
    <CardDepthContext value={1}>
      <section aria-label={label} className="min-w-0 text-sm text-foreground">
        {body}
      </section>
    </CardDepthContext>
  );
}

/** A title with a quiet line under it; `aside` (a switch, a toggle) sits at the right, or under the title when the frame is narrow. */
export function Heading({ title, meta, aside }: { title: ReactNode; meta?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
      <div className="flex min-w-[min(100%,15rem)] flex-1 flex-col">
        <h3 className="m-0 text-balance text-[15px] font-semibold leading-6 tracking-[-0.01em] text-foreground">{title}</h3>
        {meta === undefined || meta === null ? null : <p className="m-0 text-xs leading-5 text-muted-foreground">{meta}</p>}
      </div>
      {aside}
    </div>
  );
}

/** One quiet line saying what is true: empty, nothing usable. */
export function Quiet({ children }: { children: ReactNode }) {
  return <p className="m-0 text-xs leading-5 text-muted-foreground">{children}</p>;
}

/** A small two-or-more-way switch (Map | List): a single-choice toggle group. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      aria-label={label}
      value={value}
      // A press on the chosen option would clear it; a switch always has one.
      onValueChange={(next) => {
        if (next !== "") onChange(next as T);
      }}
      className="shrink-0 gap-0 rounded-md bg-surface-recessed p-0.5"
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} className="h-5 min-w-0 px-2 text-xs leading-5">
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Opens `href` through the runtime's OpenUrl action, which owns the scheme check and the user's browser choice. */
export function useOpenUrl(): (href: string) => void {
  const { run } = useUiRuntime();
  return (href) => void run([{ kind: "action", type: "openUrl", url: href }]);
}

/**
 * Vertical grid lines every `step` of an axis `span` long, as a background:
 * one per tick on every row without a DOM node each.
 */
export function gridLines(step: number, span: number): string | undefined {
  if (!(step > 0) || !(span > 0)) return undefined;
  const percent = (step / span) * 100;
  return `repeating-linear-gradient(to right, color-mix(in oklch, var(--border) 70%, transparent) 0 1px, transparent 1px ${percent}%)`;
}
