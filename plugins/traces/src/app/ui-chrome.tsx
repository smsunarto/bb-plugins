import type { RefObject } from "react";
import { eventKindSchema, topicSchema } from "../shared/model.ts";
import type { EventQuery, TraceStatus } from "../shared/schema.ts";

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

export function TraceToolbar({
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
  sessionSearchRef,
  clearSession,
  topic,
  setTopic,
  hostPicker,
  onSources,
  onHelp,
  onRefresh,
  ready,
  scanning,
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
  sessionSearchRef: RefObject<HTMLInputElement | null>;
  clearSession: () => void;
  topic: EventQuery["topic"];
  setTopic: (value: EventQuery["topic"]) => void;
  hostPicker: React.ReactNode;
  onSources: () => void;
  onHelp: () => void;
  onRefresh: () => void;
  ready: boolean;
  scanning: boolean;
}) {
  return (
    <div className="tr-toolbar">
      <div className="tr-session-search">
        <input
          ref={sessionSearchRef}
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
        <div className="tr-event-search-row">
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
      </div>
      <div className="tr-toolbar-actions">
        {hostPicker}
        <button onClick={onSources} disabled={!ready}>
          Sources
        </button>
        <button onClick={onRefresh} disabled={scanning}>
          {scanning ? "Indexing…" : "Refresh"}
        </button>
        <button className="tr-help-button" onClick={onHelp} aria-label="Keyboard shortcuts">
          ?
        </button>
      </div>
    </div>
  );
}
export function TraceFooter({
  scanning,
  onVerify,
  status,
}: {
  scanning: boolean;
  onVerify: () => void;
  status?: TraceStatus;
}) {
  return (
    <footer className="tr-footer">
      <span>
        <span className={`tr-status-dot${scanning ? " tr-working" : ""}`} />
        {scanning ? "Indexing source files" : "Local session files"}
      </span>
      <span className="tr-index-count">
        {status
          ? `${status.sessions.toLocaleString()} sessions · ${status.events.toLocaleString()} events`
          : "Connecting…"}
      </span>
      <span className="tr-footer-hint">j k Navigate · Enter Inspect · r Raw</span>
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
