// Speed bolt adapted from T3 Code's TraitsPicker.tsx.

const ZAP_PATH =
  "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z";

function Zap(props: { className?: string; strokeWidth?: number; filled?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill={props.filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={props.strokeWidth ?? 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <path d={ZAP_PATH} />
    </svg>
  );
}

/** One bolt for Fast. Ultrafast adds an outlined echo behind it, cut away by the surface color. */
export function FastBolt(props: { ultra: boolean }) {
  if (!props.ultra) return <Zap filled className="size-3 shrink-0" />;
  return (
    <span aria-hidden="true" className="relative h-3 w-[15px] shrink-0">
      <Zap className="absolute left-[3px] top-0 size-3" />
      <Zap
        filled
        strokeWidth={4}
        className="absolute left-0 top-0 size-3 stroke-[var(--agent-surface-background,var(--card))] [paint-order:stroke]"
      />
    </span>
  );
}

/** Codex's Daybreak: a sun rising over the horizon, after Lucide's `sunrise` (ISC). */
export function DaybreakGlyph(props: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <path d="M12 2v6" />
      <path d="m4.93 10.93 1.41 1.41" />
      <path d="M2 18h2" />
      <path d="M20 18h2" />
      <path d="m19.07 10.93-1.41 1.41" />
      <path d="M22 22H2" />
      <path d="m8 6 4-4 4 4" />
      <path d="M16 18a4 4 0 0 0-8 0" />
    </svg>
  );
}
