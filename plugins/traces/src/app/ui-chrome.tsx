import type { RefObject } from "react";
import { eventKindSchema, topicSchema } from "../shared/model.ts";
import type { TraceSession } from "../shared/model.ts";
import type { EventQuery, TraceStatus } from "../shared/schema.ts";
import { providerLabel } from "./controls.tsx";

export function TraceNotice({ message, retry }: { message: string; retry: () => void }) {
  if (!message) return null;
  return (
    <div className="tr-notice tr-error" role="alert">
      {message}
      <button onClick={retry}>Retry</button>
    </div>
  );
}
const topicLabels: Record<string, string> = {
  instructions: "Instructions",
  skills: "Skills",
  plugins: "Plugins",
  sandbox: "Sandbox",
  subagents: "Subagents",
  mcp: "MCP",
  search: "Search",
};

export function TraceHeader({
  hostPicker,
  onSources,
  onHelp,
  onRefresh,
  ready,
  scanning,
}: {
  hostPicker: React.ReactNode;
  onSources: () => void;
  onHelp: () => void;
  onRefresh: () => void;
  ready: boolean;
  scanning: boolean;
}) {
  return (
    <header className="tr-header">
      <div className="tr-brand">
        <span className="tr-brand-symbol" aria-hidden="true">
          ⌁
        </span>
        <h1>Traces</h1>
        <span className="tr-header-caption">Follow the evidence.</span>
      </div>
      <div className="tr-header-actions">
        {hostPicker}
        <button onClick={onSources} disabled={!ready}>
          Sources
        </button>
        <button onClick={onRefresh} disabled={scanning}>
          {scanning ? "Indexing…" : "Refresh"}
        </button>
        <button onClick={onHelp} aria-label="Keyboard shortcuts">
          ?
        </button>
      </div>
    </header>
  );
}
export function TraceFilters({
  sessionSearch,
  setSessionSearch,
  provider,
  setProvider,
  eventSearch,
  setEventSearch,
  kind,
  setKind,
  providers,
  searchRef,
  clearSession,
}: {
  sessionSearch: string;
  setSessionSearch: (value: string) => void;
  provider: string;
  setProvider: (value: string) => void;
  eventSearch: string;
  setEventSearch: (value: string) => void;
  kind: EventQuery["kind"];
  setKind: (value: EventQuery["kind"]) => void;
  providers?: TraceStatus["providers"];
  searchRef: RefObject<HTMLInputElement | null>;
  clearSession: () => void;
}) {
  return (
    <div className="tr-toolbar">
      <div className="tr-session-search">
        <input
          aria-label="Search sessions"
          placeholder="Search sessions…"
          value={sessionSearch}
          onChange={(event) => {
            setSessionSearch(event.target.value);
            clearSession();
          }}
        />
        <select
          aria-label="Filter provider"
          value={provider}
          onChange={(event) => {
            setProvider(event.target.value);
            clearSession();
          }}
        >
          <option value="">All providers</option>
          {(
            providers ?? [
              { id: "claude-code", label: "Claude Code" },
              { id: "codex", label: "Codex" },
            ]
          ).map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <div className="tr-event-search">
        <input
          ref={searchRef}
          aria-label="Search events"
          placeholder="Search this session…"
          value={eventSearch}
          onChange={(event) => setEventSearch(event.target.value)}
        />
        <kbd>/</kbd>
        <select
          aria-label="Filter event kind"
          value={kind ?? ""}
          onChange={(event) =>
            setKind(event.target.value ? eventKindSchema.parse(event.target.value) : undefined)
          }
        >
          <option value="">All events</option>
          {eventKindSchema.options.map((item) => (
            <option key={item} value={item}>
              {item.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
export function TraceTopics({
  topic,
  setTopic,
  status,
}: {
  topic: EventQuery["topic"];
  setTopic: (value: EventQuery["topic"]) => void;
  status?: TraceStatus;
}) {
  return (
    <div className="tr-topic-bar">
      <div className="tr-topic-buttons">
        <button aria-pressed={!topic} onClick={() => setTopic(undefined)}>
          Everything
        </button>
        {topicSchema.options.map((item) => (
          <button
            key={item}
            aria-pressed={topic === item}
            onClick={() => setTopic(topic === item ? undefined : item)}
          >
            {topicLabels[item]}
          </button>
        ))}
      </div>
      <span className="tr-index-count">
        {status
          ? `${status.sessions.toLocaleString()} sessions · ${status.events.toLocaleString()} events`
          : "Connecting…"}
      </span>
    </div>
  );
}
export function SessionHeading({ session }: { session: TraceSession | null }) {
  return (
    <div className="tr-session-heading">
      <div>
        <h2>{session?.title ?? "Select a session"}</h2>
        <span>
          {session
            ? `${providerLabel(session.provider)}${session.model ? ` · ${session.model}` : ""}`
            : "Inspect conversations and tool activity"}
        </span>
      </div>
      {session && (
        <span className="tr-session-counters">
          {session.toolCount} tools
          {session.errorCount > 0 ? ` · ${session.errorCount} errors` : ""}
        </span>
      )}
    </div>
  );
}
export function TraceFooter({ scanning, onVerify }: { scanning: boolean; onVerify: () => void }) {
  return (
    <footer className="tr-footer">
      <span>
        <span className={`tr-status-dot${scanning ? " tr-working" : ""}`} />
        {scanning ? "Indexing source files" : "Local session files"}
      </span>
      <span>j k Navigate · Enter Inspect · r Raw</span>
      <button className="tr-text-button" onClick={onVerify} disabled={scanning}>
        Verify sources
      </button>
    </footer>
  );
}

export function ThreadScope({
  visible,
  enabled,
  onChange,
}: {
  visible: boolean;
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  if (!visible) return null;
  return (
    <div className="tr-context-banner">
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        This BB thread only
      </label>
    </div>
  );
}
