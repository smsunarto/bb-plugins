import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import type { TraceEvidence } from "../shared/model.ts";

export function focusList(element: HTMLElement | null) {
  const selected = element?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
  (selected ?? element?.querySelector<HTMLButtonElement>("button"))?.focus();
}
export function useContainerWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
// null means "follow the container width". A drag pins the pane; a double-click unpins it.
export function parseStoredSize(raw: string | null | undefined) {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const size = Number(raw);
  return Number.isFinite(size) ? size : null;
}
export function useStoredSize(key: string) {
  const [size, setSize] = useState<number | null>(() => parseStoredSize(storage()?.getItem(key)));
  const store = useCallback(
    (next: number | null) => {
      setSize(next);
      if (next === null) storage()?.removeItem(key);
      else storage()?.setItem(key, String(next));
    },
    [key],
  );
  return [size, store] as const;
}
export function Splitter({
  label,
  value,
  min,
  max,
  onMove,
  onStep,
  onReset,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onMove: (clientX: number) => void;
  onStep: (direction: number, coarse: boolean) => void;
  onReset: () => void;
}) {
  return (
    // hr carries an implicit role="separator". The ARIA window splitter pattern
    // makes that separator focusable and arrow-key driven, which oxlint's
    // non-interactive rules do not model.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex
    <hr
      className="tr-splitter"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      title={`${label}. Drag, or arrow keys. Double-click to reset.`}
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        event.preventDefault();
        const move = (moved: PointerEvent) => onMove(moved.clientX);
        const stop = () => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", stop);
          document.body.classList.remove("tr-resizing");
        };
        document.body.classList.add("tr-resizing");
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", stop);
      }}
      onKeyDown={(event) => {
        const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
        if (direction === 0) return;
        event.preventDefault();
        event.stopPropagation();
        onStep(direction, event.shiftKey);
      }}
    />
  );
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
export function elapsedTime(value: number | null, from: number | null) {
  if (value === null || from === null || value < from) return eventTime(value);
  const total = Math.round((value - from) / 1000);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = String(total % 60).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `+${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `+${minutes}:${seconds}`;
}
export function evidenceLabel(item: TraceEvidence) {
  return `${item.topic} · ${item.action.replaceAll("_", " ")} · ${item.label}`;
}
// Rows are narrow, and the toolbar already filters by topic. The chip
// spends its width on the action and the label that separate one fact from the next.
export function evidenceTag(item: TraceEvidence) {
  return `${item.action.replaceAll("_", " ")} · ${item.label}`;
}
export function distinctEvidence(evidence: readonly TraceEvidence[]) {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = evidenceLabel(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function providerLabel(value: string) {
  return value === "claude-code" ? "Claude Code" : value === "codex" ? "Codex" : value;
}
const topicNames: Readonly<Record<TraceEvidence["topic"], string>> = {
  instructions: "Instructions",
  skills: "Skills",
  plugins: "Plugins",
  sandbox: "Sandbox",
  subagents: "Subagents",
  mcp: "MCP",
  search: "Search",
};
export type EvidenceState = "available" | "pending" | "unavailable";
export type EvidenceGroup = {
  key: string;
  topic: TraceEvidence["topic"];
  name: string;
  state: EvidenceState | null;
  items: TraceEvidence[];
};
// MCP tool names carry their server: mcp__<server>__<tool>, or mcp__<server>.<tool>.
// A server-level fact is the bare name, optionally with the recorded state in
// parentheses, so both forms have to collapse onto the same server group.
function mcpName(label: string) {
  return label.startsWith("mcp__") ? label.slice(5) : label;
}
export function mcpServer(label: string) {
  const name = mcpName(label).replace(/\s*\([^()]*\)$/, "");
  return name.split(/__|\./)[0] || label;
}
export function mcpEntry(label: string) {
  const name = mcpName(label);
  const tool = name.split(/__|\./).slice(1).join("__");
  if (tool) return tool;
  return (
    name
      .slice(mcpServer(label).length)
      .trim()
      .replace(/^\(|\)$/g, "") || "Server"
  );
}
// One denied fact outweighs any number of successful ones: a server that failed to
// start is unavailable even when the trace also recorded the tools it advertised.
function evidenceState(items: readonly TraceEvidence[]): EvidenceState {
  if (items.some((item) => item.action === "blocked")) return "unavailable";
  if (items.every((item) => item.action === "requested")) return "pending";
  return "available";
}
export function groupEvidence(evidence: readonly TraceEvidence[]): EvidenceGroup[] {
  const groups = new Map<string, EvidenceGroup>();
  for (const item of distinctEvidence(evidence)) {
    const server = item.topic === "mcp" ? mcpServer(item.label) : null;
    const key = server ? `mcp:${server}` : item.topic;
    const group = groups.get(key) ?? {
      key,
      topic: item.topic,
      name: server ?? topicNames[item.topic],
      state: null,
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  const ordered = [...groups.values()];
  for (const group of ordered)
    group.state = group.topic === "mcp" ? evidenceState(group.items) : null;
  return ordered;
}
const stateNames: Readonly<Record<EvidenceState, string>> = {
  available: "Available",
  pending: "Pending",
  unavailable: "Unavailable",
};
export function Evidence({ evidence }: { evidence: readonly TraceEvidence[] }) {
  const groups = groupEvidence(evidence);
  if (groups.length === 0) return null;
  return (
    <div className="tr-evidence">
      {groups.map((group) => (
        <section
          className="tr-evidence-group"
          key={group.key}
          data-state={group.state ?? undefined}
        >
          <h4 className="tr-evidence-group-name">
            {group.topic === "mcp" && <span className="tr-evidence-scope">MCP</span>}
            <span>{group.name}</span>
            {group.state && (
              <span className={`tr-evidence-state tr-evidence-state-${group.state}`}>
                {stateNames[group.state]}
              </span>
            )}
          </h4>
          <div className="tr-evidence-chips">
            {group.items.map((item) => (
              <span
                key={evidenceLabel(item)}
                className={`tr-evidence-chip tr-evidence-${item.action}`}
                title={`${item.basis === "recorded" ? "Recorded" : "Inferred from submitted content"} · ${item.pointer}`}
              >
                <span>{group.topic === "mcp" ? mcpEntry(item.label) : item.label}</span>
                <small>
                  {item.action.replaceAll("_", " ")}
                  {item.basis === "inferred" ? " · inferred" : ""}
                </small>
              </span>
            ))}
          </div>
        </section>
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
