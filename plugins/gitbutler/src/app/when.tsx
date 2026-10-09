import { absoluteTime, relativeTime } from "./format.ts";

/**
 * A relative time that shows the full date and time on hover. "3d ago" is
 * quick to read but loses the day, which is what a reader comparing commits
 * goes looking for.
 */
export function When({
  value,
  now,
  className,
}: {
  /** An ISO timestamp from the CLI. */
  value: string;
  now?: number;
  className?: string;
}) {
  const relative = relativeTime(value, now);
  // The CLI leaves some dates out, and an empty `time` would still take a gap.
  if (!relative) return null;
  return (
    <time dateTime={value} title={absoluteTime(value)} className={className}>
      {relative}
    </time>
  );
}
