import { useId } from "react";
import type { RefObject } from "react";
import { experimental_ShortcutHint as ShortcutHint } from "@get-bb/plugin-sdk/app";
import { eventKindSchema, topicSchema } from "../shared/model.ts";
import type { EventQuery, TraceStatus } from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { Toggle } from "./components/ui/toggle.tsx";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.tsx";

export function TraceNotice({ message, retry }: { message: string; retry: () => void }) {
  if (!message) return null;
  return (
    <div className="tr-notice tr-error" role="alert">
      {message}
      <Button variant="outline" size="sm" onClick={retry}>
        Retry
      </Button>
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
// Radix Select and ToggleGroup reserve "" for "nothing chosen", so "All" needs its own value.
const ALL = "all";
const EVERYTHING = "everything";

export function TraceToolbar({
  sessionSearch,
  setSessionSearch,
  provider,
  setProvider,
  eventSearch,
  setEventSearch,
  kind,
  setKind,
  includeUsage,
  setIncludeUsage,
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
  includeUsage: boolean;
  setIncludeUsage: (value: boolean) => void;
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
        <Input
          ref={sessionSearchRef}
          type="search"
          className="h-8 min-w-0"
          aria-label="Search sessions"
          placeholder="Search sessions…"
          value={sessionSearch}
          onChange={(event) => {
            setSessionSearch(event.target.value);
            clearSession();
          }}
        />
        <Select
          value={provider || ALL}
          onValueChange={(value) => {
            setProvider(value === ALL ? "" : value);
            clearSession();
          }}
        >
          <SelectTrigger aria-label="Filter provider" className="tr-provider-select h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ALL}>All providers</SelectItem>
              {(
                providers ?? [
                  { id: "claude-code", label: "Claude Code" },
                  { id: "codex", label: "Codex" },
                ]
              ).map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="tr-event-search">
        <div className="tr-event-search-row">
          <Input
            ref={searchRef}
            type="search"
            className="h-8 min-w-0"
            aria-label="Search events"
            placeholder="Search this session…"
            value={eventSearch}
            onChange={(event) => setEventSearch(event.target.value)}
          />
          <ShortcutHint className="tr-shortcut" shortcut={{ label: "/", ariaKeyshortcuts: "/" }} />
          <Select
            value={kind ?? ALL}
            onValueChange={(value) =>
              setKind(value === ALL ? undefined : eventKindSchema.parse(value))
            }
          >
            <SelectTrigger aria-label="Filter event kind" className="tr-kind-select h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All events</SelectItem>
                {eventKindSchema.options.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Tooltip>
            {/* Toggle wraps the trigger: both write data-state, and the toggle's on/off must win. */}
            <Toggle
              asChild
              size="sm"
              className="shrink-0 text-xs"
              pressed={includeUsage}
              onPressedChange={setIncludeUsage}
            >
              <TooltipTrigger>Usage</TooltipTrigger>
            </Toggle>
            <TooltipContent>Response usage records are hidden until this is on</TooltipContent>
          </Tooltip>
        </div>
        <ToggleGroup
          type="single"
          size="sm"
          aria-label="Filter by topic"
          className="tr-topic-buttons justify-start"
          value={topic ?? EVERYTHING}
          onValueChange={(value) =>
            setTopic(value && value !== EVERYTHING ? topicSchema.parse(value) : undefined)
          }
        >
          <ToggleGroupItem value={EVERYTHING} className="h-7 shrink-0 text-xs">
            Everything
          </ToggleGroupItem>
          {topicSchema.options.map((item) => (
            <ToggleGroupItem key={item} value={item} className="h-7 shrink-0 text-xs">
              {topicLabels[item]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="tr-toolbar-actions">
        {hostPicker}
        <Button variant="outline" size="sm" onClick={onSources} disabled={!ready}>
          Sources
        </Button>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={scanning}>
          {scanning ? "Indexing…" : "Refresh"}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="tr-help-button size-8"
              onClick={onHelp}
              aria-label="Keyboard shortcuts"
            >
              ?
            </Button>
          </TooltipTrigger>
          <TooltipContent>Keyboard shortcuts</TooltipContent>
        </Tooltip>
      </div>
    </div>
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
  const id = useId();
  if (!visible) return null;
  return (
    <div className="tr-context-banner">
      <Checkbox id={id} checked={enabled} onCheckedChange={(value) => onChange(value === true)} />
      <Label htmlFor={id} className="text-xs font-normal">
        This BB thread only
      </Label>
    </div>
  );
}
