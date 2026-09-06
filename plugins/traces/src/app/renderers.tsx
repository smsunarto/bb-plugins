import type { ComponentType } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { TraceBody, TraceEvent } from "../shared/model.ts";
import { JsonView } from "./json-view.tsx";

export interface TraceRendererProps {
  event: TraceEvent;
  body: TraceBody;
  related: readonly TraceEvent[];
}
export type TraceRenderer = ComponentType<TraceRendererProps>;
export interface TraceRendererRegistration {
  template: string;
  component: TraceRenderer;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function field(value: unknown, ...keys: string[]): string | null {
  const object = record(value);
  for (const key of keys) if (typeof object[key] === "string") return object[key];
  return typeof value === "string" ? value : null;
}
function Text({ text, markdown = false }: { text: string; markdown?: boolean }) {
  return markdown ? (
    <div className="tr-markdown">
      <Markdown content={text} />
    </div>
  ) : (
    <pre className="tr-code">{text}</pre>
  );
}
function ToolOutput({ body }: { body: TraceBody }) {
  if (body.type !== "tool" || body.output === null) return null;
  return (
    <div className="tr-detail-section">
      <h3>Result</h3>
      {typeof body.output === "string" ? (
        <Text text={body.output} />
      ) : (
        <JsonView value={body.output} />
      )}
    </div>
  );
}
function MessageRenderer({ body }: TraceRendererProps) {
  if (body.type === "text") return <Text text={body.text} markdown={body.format === "markdown"} />;
  return <GenericRenderer body={body} />;
}
function GenericRenderer({ body }: { body: TraceBody }) {
  switch (body.type) {
    case "text":
      return <Text text={body.text} markdown={body.format === "markdown"} />;
    case "context":
      return <ContextRenderer body={body} />;
    case "tool":
      return (
        <>
          <div className="tr-detail-section">
            <h3>Arguments</h3>
            <JsonView value={body.input} />
          </div>
          <ToolOutput body={body} />
        </>
      );
    case "data":
      return <JsonView value={body.value} />;
  }
}
function ContextRenderer({ body }: { body: TraceBody }) {
  if (body.type !== "context") return <GenericRenderer body={body} />;
  return (
    <>
      <div className="tr-context-origin">
        {body.captured ? "Captured in this trace" : "Referenced in this trace"}
      </div>
      <h3 className="tr-context-title">{body.name}</h3>
      <Text text={body.content} markdown={body.format === "markdown"} />
    </>
  );
}
function CommandRenderer({ body }: TraceRendererProps) {
  if (body.type !== "tool") return <GenericRenderer body={body} />;
  const command = field(body.input, "cmd", "command", "code", "input");
  return (
    <>
      {command ? (
        <div className="tr-detail-section">
          <h3>Command</h3>
          <Text text={command} />
        </div>
      ) : (
        <JsonView value={body.input} />
      )}
      <ToolOutput body={body} />
    </>
  );
}
function FileRenderer({ body, event }: TraceRendererProps) {
  if (body.type !== "tool") return <GenericRenderer body={body} />;
  const path = field(body.input, "file_path", "path", "filename");
  const content = field(body.input, "content", "new_string", "new_str", "patch");
  const previous = field(body.input, "old_string", "old_str");
  return (
    <>
      {path && <div className="tr-file-path">{path}</div>}
      {previous !== null && (
        <div className="tr-detail-section tr-before">
          <h3>Before</h3>
          <Text text={previous} />
        </div>
      )}
      {content !== null && (
        <div className="tr-detail-section tr-after">
          <h3>{previous === null ? "Content" : "After"}</h3>
          <Text text={content} />
        </div>
      )}
      {content === null && event.kind === "tool_call" && <JsonView value={body.input} />}
      <ToolOutput body={body} />
    </>
  );
}
function PatchRenderer({ body }: TraceRendererProps) {
  const patch =
    body.type === "tool"
      ? field(body.input, "patch", "input", "content")
      : body.type === "text"
        ? body.text
        : null;
  if (patch === null) return <GenericRenderer body={body} />;
  const lines = [];
  for (const match of patch.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (lines.length >= 2000) break;
    lines.push(match);
  }
  return (
    <>
      <pre className="tr-code tr-patch">
        {lines.map((match) => (
          <span
            key={match.index}
            className={
              match[0].startsWith("+") ? "tr-added" : match[0].startsWith("-") ? "tr-removed" : ""
            }
          >
            {match[0]}
          </span>
        ))}
      </pre>
      {lines.length === 2000 && (
        <p className="tr-notice">
          Preview limited to 2,000 lines. Open raw for the complete record.
        </p>
      )}
      <ToolOutput body={body} />
    </>
  );
}
function SearchRenderer({ body }: TraceRendererProps) {
  if (body.type !== "tool") return <GenericRenderer body={body} />;
  const query = field(body.input, "query", "q", "objective");
  return (
    <>
      {query && <div className="tr-search-query">{query}</div>}
      <JsonView value={body.input} />
      <ToolOutput body={body} />
    </>
  );
}
function SubagentRenderer({ body }: TraceRendererProps) {
  if (body.type !== "tool") return <GenericRenderer body={body} />;
  const prompt = field(body.input, "prompt", "message");
  const label = field(body.input, "task_name", "description", "subagent_type", "agent_type");
  return (
    <>
      {label && <h3>{label}</h3>}
      {prompt && (
        <div className="tr-detail-section">
          <h3>Delegated task</h3>
          <Text text={prompt} markdown />
        </div>
      )}
      <JsonView value={body.input} />
      <ToolOutput body={body} />
    </>
  );
}
function UsageRenderer({ event, body }: TraceRendererProps) {
  return (
    <>
      {event.usage && (
        <dl className="tr-usage">
          <div>
            <dt>Input</dt>
            <dd>{event.usage.input?.toLocaleString() ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{event.usage.output?.toLocaleString() ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt>Cached</dt>
            <dd>{event.usage.cached?.toLocaleString() ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>{event.usage.scope}</dd>
          </div>
        </dl>
      )}
      <GenericRenderer body={body} />
    </>
  );
}
const builtinRenderers: Readonly<Record<string, TraceRenderer>> = {
  message: MessageRenderer,
  reasoning: MessageRenderer,
  command: CommandRenderer,
  read: FileRenderer,
  write: FileRenderer,
  edit: FileRenderer,
  patch: PatchRenderer,
  search: SearchRenderer,
  mcp: GenericRenderer,
  subagent: SubagentRenderer,
  skill: GenericRenderer,
  context: ContextRenderer,
  instructions: ContextRenderer,
  usage: UsageRenderer,
  turn: GenericRenderer,
  data: GenericRenderer,
};

export function createTraceRendererRegistry(extensions: readonly TraceRendererRegistration[] = []) {
  const templates = new Map(Object.entries(builtinRenderers));
  const custom = new Set<string>();
  for (const extension of extensions) {
    if (!extension.template.trim() || custom.has(extension.template))
      throw new Error(`Duplicate or empty trace renderer: ${extension.template}`);
    custom.add(extension.template);
    templates.set(extension.template, extension.component);
  }
  return Object.freeze({
    resolve(template: string): TraceRenderer {
      return templates.get(template) ?? GenericRenderer;
    },
    templates: Object.freeze([...templates.keys()]),
  });
}
export const defaultTraceRenderers = createTraceRendererRegistry();
export type TraceRendererRegistry = ReturnType<typeof createTraceRendererRegistry>;
