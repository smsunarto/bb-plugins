import { useCallback, useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import type { TraceEvidence } from "../shared/model.ts";

export function focusList(element: HTMLElement | null) {
  const selected = element?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
  (selected ?? element?.querySelector<HTMLButtonElement>("button"))?.focus();
}
export function useDisclosure() {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  return [open, show, hide] as const;
}

export function useDebounced(value: string, delay = 220) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
export function moveSelection(
  event: KeyboardEvent,
  current: number,
  length: number,
): number | null {
  const keys: Record<string, number> = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
  if (event.ctrlKey || event.altKey || event.metaKey || length === 0) return null;
  if (event.key === "Home") {
    event.preventDefault();
    return 0;
  }
  if (event.key === "End") {
    event.preventDefault();
    return length - 1;
  }
  const delta = keys[event.key];
  if (delta === undefined) return null;
  event.preventDefault();
  return Math.max(0, Math.min(length - 1, current + delta));
}
export function shortDate(value: number | null) {
  if (value === null) return "Time not recorded";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function eventTime(value: number | null) {
  return value === null ? "" : new Date(value).toLocaleTimeString(undefined, { hour12: false });
}
export function providerLabel(value: string) {
  return value === "claude-code" ? "Claude Code" : value === "codex" ? "Codex" : value;
}
export function Evidence({ evidence }: { evidence: readonly TraceEvidence[] }) {
  return (
    <div className="tr-evidence">
      {evidence.map((item) => (
        <span
          key={`${item.topic}-${item.action}-${item.label}-${item.pointer}`}
          className={`tr-evidence-chip tr-evidence-${item.action}`}
          title={`${item.basis === "recorded" ? "Recorded" : "Inferred from submitted content"} · ${item.pointer}`}
        >
          <span>{item.label}</span>
          <small>
            {item.action.replaceAll("_", " ")}
            {item.basis === "inferred" ? " · inferred" : ""}
          </small>
        </span>
      ))}
    </div>
  );
}
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="tr-empty">
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  );
}
export function QueryError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div className="tr-error" role="alert">
      <p>{error.message}</p>
      <button onClick={retry}>Try again</button>
    </div>
  );
}
export function Pages({
  page,
  hasNext,
  onPrevious,
  onNext,
  loading,
}: {
  page: number;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  loading: boolean;
}) {
  return (
    <div className="tr-pages">
      <button disabled={page === 0 || loading} onClick={onPrevious} aria-label="Previous page">
        ← Previous
      </button>
      <span>Page {page + 1}</span>
      <button disabled={!hasNext || loading} onClick={onNext} aria-label="Next page">
        Next →
      </button>
    </div>
  );
}
