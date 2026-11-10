/**
 * The review page's small glyphs, drawn as board A draws them, in theme
 * colours so a theme change recolours them.
 */
import type { RowState } from "../../core/review.ts";

const INK_3 = "var(--tertiary-foreground)";

const STATE_STROKE: Record<RowState, string> = {
  local: INK_3,
  draft: INK_3,
  open: "var(--success)",
  merged: "var(--pr-merged)",
  closed: "var(--destructive)",
};

const LABEL: Record<RowState, string> = {
  local: "Local branch",
  draft: "Draft pull request",
  open: "Open pull request",
  merged: "Merged pull request",
  closed: "Closed pull request",
};

/** A Change's state: a branch, a draft, an open, merged or closed pull request. */
export function StateIcon({
  state,
  phone = false,
  size = 14,
}: {
  state: RowState;
  /** The phone list draws a local branch as a dashed ring. */
  phone?: boolean;
  size?: number;
}) {
  const stroke = STATE_STROKE[state];
  if (state === "local" && phone)
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 14 14"
        className="shrink-0"
        aria-label={LABEL[state]}
      >
        <circle
          cx="7"
          cy="7"
          r="5"
          fill="none"
          stroke={stroke}
          strokeWidth="1.3"
          strokeDasharray="2.4 2"
        />
      </svg>
    );
  const top = state === "local" ? [7.5, 2.5] : state === "merged" ? [7.5, 5.6] : [7.5, 8];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      className="shrink-0"
      aria-label={LABEL[state]}
    >
      <circle cx="2.5" cy="2" r="1.2" fill="none" stroke={stroke} />
      <circle cx="2.5" cy="8" r="1.2" fill="none" stroke={stroke} />
      <circle cx={top[0]} cy={top[1]} r="1.2" fill="none" stroke={stroke} />
      {state === "local" ? (
        <path
          d="M2.5 3.2V6.8M7.5 3.7C7.5 5 6.5 5.4 4.6 5.4C3.3 5.4 2.5 5.9 2.5 6.8"
          fill="none"
          stroke={stroke}
          strokeLinecap="round"
        />
      ) : state === "merged" ? (
        <path
          d="M2.5 3.2V6.8M2.7 3.2C3 4.8 4.2 5.6 6.3 5.6"
          fill="none"
          stroke={stroke}
          strokeLinecap="round"
        />
      ) : state === "draft" ? (
        <>
          <path d="M2.5 3.2V6.8" fill="none" stroke={stroke} strokeLinecap="round" />
          <path
            d="M7.5 6.3V1.6"
            fill="none"
            stroke={stroke}
            strokeLinecap="round"
            strokeDasharray="0.1 1.8"
          />
        </>
      ) : (
        <path
          d="M2.5 3.2V6.8M7.5 6.8V4.5C7.5 3.4 6.9 2.8 5.8 2.8H5"
          fill="none"
          stroke={stroke}
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

/** Three stacked sheets: a stack of branches. */
export function StackIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" className="shrink-0" aria-hidden>
      <path
        d="M6.5 1.5L11.5 4L6.5 6.5L1.5 4L6.5 1.5Z"
        fill="none"
        stroke={INK_3}
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path
        d="M1.5 6.5L6.5 9L11.5 6.5M1.5 9L6.5 11.5L11.5 9"
        fill="none"
        stroke={INK_3}
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A screen: the host a checkout is on. */
export function HostIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0" aria-hidden>
      <rect
        x="1"
        y="1.5"
        width="8"
        height="5.5"
        rx="1"
        fill="none"
        stroke={INK_3}
        strokeWidth="1.1"
      />
      <path d="M3.5 9H6.5" fill="none" stroke={INK_3} strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

export function Chevron({ className, stroke = INK_3 }: { className?: string; stroke?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className={className ?? "shrink-0"} aria-hidden>
      <path
        d="M3 4.5L6 7.5L9 4.5"
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ArrowRight() {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" className="shrink-0" aria-label="into">
      <path
        d="M1.5 6H12M8.5 2.5L12 6L8.5 9.5"
        fill="none"
        stroke={INK_3}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function GitHubMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <path
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
        fill="currentColor"
      />
    </svg>
  );
}

/** A check's outcome, as the ship path draws its steps. */
export function CheckIcon({ outcome }: { outcome: "passed" | "failed" | "pending" | "skipped" }) {
  if (outcome === "pending")
    return (
      <svg width="12" height="12" viewBox="0 0 14 14" className="shrink-0" aria-label="Running">
        <circle
          cx="7"
          cy="7"
          r="5.25"
          fill="none"
          stroke="var(--warning)"
          strokeWidth="1.5"
          strokeDasharray="3 2.5"
        />
      </svg>
    );
  if (outcome === "failed")
    return (
      <svg width="12" height="12" viewBox="0 0 14 14" className="shrink-0" aria-label="Failed">
        <circle cx="7" cy="7" r="5.25" fill="none" stroke="var(--destructive)" strokeWidth="1.5" />
        <path
          d="M5 5L9 9M9 5L5 9"
          fill="none"
          stroke="var(--destructive)"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      className="shrink-0"
      aria-label={outcome === "skipped" ? "Skipped" : "Passed"}
    >
      <circle cx="7" cy="7" r="6" fill="var(--success)" />
      <path
        d="M4.5 7.2L6.2 8.9L9.5 5.4"
        fill="none"
        stroke="var(--background)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
