/**
 * The review's small parts, shared by the rail, the diff's annotations and
 * the thread tab's card: the checkbox, the priority chip and the author
 * marks, drawn as boards A, A3 and B draw them.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { Viewer } from "../core/items.ts";
import { Checkbox as UiCheckbox } from "./components/ui/checkbox.tsx";
import { cx } from "./format.ts";

/** shadcn's Checkbox with its label: `label` names it when no visible `children` follow the mark. */
export function Checkbox({
  checked,
  label,
  onChange,
  className,
  testId,
  children,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  className?: string;
  testId?: string;
  /** A visible label after the mark; without one, `label` names it for assistive tech. */
  children?: ReactNode;
}) {
  return (
    <label className={cx("relative flex shrink-0 cursor-pointer items-center", className)}>
      <UiCheckbox
        checked={checked}
        aria-label={children ? undefined : label}
        data-testid={testId}
        onCheckedChange={(next) => onChange(next === true)}
        className="size-4 data-[state=checked]:border-transparent data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
      />
      {children}
    </label>
  );
}

const PRIORITY = [
  "bg-destructive text-primary-foreground",
  "bg-[color-mix(in_oklab,var(--warning)_15%,transparent)] text-warning",
  "bg-surface-raised text-(--tertiary-foreground)",
  "bg-surface-raised text-(--tertiary-foreground)",
] as const;

/** P0 to P3. Only findings have one. */
export function PriorityChip({ priority }: { priority: number }) {
  return (
    <span
      className={cx(
        "flex h-4 shrink-0 items-center rounded-[4px] px-1 text-[11px] leading-3 font-bold",
        PRIORITY[priority] ?? PRIORITY[3],
      )}
    >
      P{priority}
    </span>
  );
}

/** A small pill after a line's author: Pending, Outdated, Resolved. */
export function StatePill({ tone, children }: { tone: "warning" | "quiet"; children: ReactNode }) {
  return (
    <span
      className={cx(
        "flex h-4 shrink-0 items-center rounded-full border border-solid border-border px-2 text-[11px] leading-3 font-semibold",
        tone === "warning" ? "text-warning" : "text-(--tertiary-foreground)",
      )}
    >
      {children}
    </span>
  );
}

/** bb's and SlopCop's mark: a robot on a control tile. */
export function BotMark() {
  return (
    <span
      aria-hidden
      className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-surface-raised"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
        <path
          d="M12 8V4H8M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM15 13v2M9 13v2"
          fill="none"
          stroke="var(--tertiary-foreground)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** A GitHub login's avatar, GitHub serves any login's at a fixed URL. */
export function PersonMark({ login, size = 16 }: { login: string; size?: 14 | 16 }) {
  return (
    <img
      src={`https://github.com/${encodeURIComponent(login)}.png?size=32`}
      alt=""
      loading="lazy"
      width={size}
      height={size}
      className="shrink-0 rounded-full bg-surface-raised"
    />
  );
}

/** Who "You" is: the GitHub account the review is read as; null before any read. */
export const ViewerContext = createContext<Viewer | null>(null);

/** The reader's own mark on a draft, as board A3 draws "You". */
export function YouMark() {
  return <span aria-hidden className="size-3.5 shrink-0 rounded-full bg-primary" />;
}

/** The reader on a draft or composer: their avatar and login, or the dot and "You" before bb knows them. */
export function Me() {
  const viewer = useContext(ViewerContext);
  return (
    <>
      {viewer?.avatarUrl ? (
        <img
          src={viewer.avatarUrl}
          alt=""
          loading="lazy"
          width={14}
          height={14}
          className="size-3.5 shrink-0 rounded-full bg-surface-raised"
        />
      ) : (
        <YouMark />
      )}
      <span className="text-[12px] leading-4 font-semibold text-foreground" data-testid="sc-me">
        {viewer?.login ?? "You"}
      </span>
    </>
  );
}

/** An item an agent is fixing: the dashed warning ring, in the checkbox's 16 px box (board A4). */
export function FixingMark() {
  return (
    <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
      <RunGlyph state="running" />
    </span>
  );
}

/** The ✓, dashed ring and ✕ a review run's state is drawn with. */
export function RunGlyph({ state }: { state: "running" | "done" | "failed" }) {
  if (state === "running")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
        <circle
          cx="6"
          cy="6"
          r="4.4"
          fill="none"
          stroke="var(--warning)"
          strokeWidth="1.4"
          strokeDasharray="2.2 2"
        />
      </svg>
    );
  if (state === "failed")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
        <path
          d="M3.5 3.5L8.5 8.5M8.5 3.5L3.5 8.5"
          fill="none"
          stroke="var(--destructive)"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
      <path
        d="M2.5 6.3L4.8 8.5L9.5 3.5"
        fill="none"
        stroke="var(--success)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
