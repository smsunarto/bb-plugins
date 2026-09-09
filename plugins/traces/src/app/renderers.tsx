import type { ComponentType } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { TraceBody, TraceEvent } from "../shared/model.ts";
import { scanInstructions } from "../shared/providers/common.ts";
import { JsonView } from "./json-view.tsx";

export interface TraceRendererProps {
  event: TraceEvent;
  body: TraceBody;
  related: readonly TraceEvent[];
  onRaw?: () => void;
}
export type TraceRenderer = ComponentType<TraceRendererProps>;
export interface TraceRendererRegistration {
  template: string;
  component: TraceRenderer;
}

const EMPTY_RELATED: readonly TraceEvent[] = [];
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
// The timeline folds a tool result into the call that produced it, so the call has
// to show that result here. Only the summary is indexed, so a long result is
// shortened and the full record stays one click away under Related events.
function PairedOutput({ related }: { related: readonly TraceEvent[] }) {
  const result = related.find((item) => item.kind === "tool_result");
  if (!result) return null;
  return (
    <div className="tr-detail-section">
      <h3>Result{result.tool ? ` · ${result.tool.status}` : ""}</h3>
      <Text text={result.preview} />
    </div>
  );
}
function ToolOutput({ body, related }: { body: TraceBody; related?: readonly TraceEvent[] }) {
  if (body.type !== "tool") return null;
  if (body.output === null) return <PairedOutput related={related ?? EMPTY_RELATED} />;
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
function MessageRenderer({ body, related, onRaw }: TraceRendererProps) {
  if (body.type === "text") return <Text text={body.text} markdown={body.format === "markdown"} />;
  return <GenericRenderer body={body} related={related} onRaw={onRaw} />;
}
type BodyProps = { body: TraceBody; related?: readonly TraceEvent[]; onRaw?: () => void };
function GenericRenderer({ body, related, onRaw }: BodyProps) {
  switch (body.type) {
    case "text":
      return <Text text={body.text} markdown={body.format === "markdown"} />;
    case "context":
      return <ContextRenderer body={body} related={related} onRaw={onRaw} />;
    case "tool":
      return (
        <>
          <div className="tr-detail-section">
            <h3>Arguments</h3>
            <JsonView value={body.input} />
          </div>
          <ToolOutput body={body} related={related} />
        </>
      );
    case "data":
      return <JsonView value={body.value} />;
  }
}
function ContextHeading({ body }: { body: TraceBody & { type: "context" } }) {
  return (
    <>
      <div className="tr-context-origin">
        {body.captured ? "Captured in this trace" : "Referenced in this trace"}
      </div>
      <h3 className="tr-context-title">{body.name}</h3>
    </>
  );
}
function ContextRenderer({ body, related, onRaw }: BodyProps) {
  if (body.type !== "context")
    return <GenericRenderer body={body} related={related} onRaw={onRaw} />;
  return (
    <>
      <ContextHeading body={body} />
      <Text text={body.content} markdown={body.format === "markdown"} />
    </>
  );
}
// BB assembles one instruction message from many sources. Splitting it back into
// the plugin or memory file each part came from is what makes it readable.
function InstructionsRenderer({ body, related, onRaw }: TraceRendererProps) {
  const scan = body.type === "context" ? scanInstructions(body.content) : null;
  if (body.type !== "context" || !scan?.kind)
    return <ContextRenderer body={body} related={related} onRaw={onRaw} />;
  const markdown = body.format === "markdown";
  return (
    <>
      <ContextHeading body={body} />
      {scan.preamble && <Text text={scan.preamble} markdown={markdown} />}
      {scan.sections.map((section) => (
        <details className="tr-detail-section tr-instruction" key={section.label} open>
          <summary>{section.label}</summary>
          <Text text={section.content} markdown={markdown} />
        </details>
      ))}
    </>
  );
}
function CommandRenderer({ body, related, onRaw }: TraceRendererProps) {
  if (body.type !== "tool") return <GenericRenderer body={body} related={related} onRaw={onRaw} />;
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
      <ToolOutput body={body} related={related} />
    </>
  );
}
function FileRenderer({ body, event, related, onRaw }: TraceRendererProps) {
  if (body.type !== "tool") return <GenericRenderer body={body} related={related} onRaw={onRaw} />;
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
      <ToolOutput body={body} related={related} />
    </>
  );
}
function PatchRenderer({ body, related, onRaw }: TraceRendererProps) {
  const patch =
    body.type === "tool"
      ? field(body.input, "patch", "input", "content")
      : body.type === "text"
        ? body.text
        : null;
  if (patch === null) return <GenericRenderer body={body} related={related} onRaw={onRaw} />;
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
      <ToolOutput body={body} related={related} />
    </>
  );
}
function SearchRenderer({ body, related, onRaw }: TraceRendererProps) {
  if (body.type !== "tool") return <GenericRenderer body={body} related={related} onRaw={onRaw} />;
  const query = field(body.input, "query", "q", "objective");
  return (
    <>
      {query && <div className="tr-search-query">{query}</div>}
      <JsonView value={body.input} />
      <ToolOutput body={body} related={related} />
    </>
  );
}
function SubagentRenderer({ body, related, onRaw }: TraceRendererProps) {
  if (body.type !== "tool") return <GenericRenderer body={body} related={related} onRaw={onRaw} />;
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
      <ToolOutput body={body} related={related} />
    </>
  );
}
function UsageRenderer({ event, body, related, onRaw }: TraceRendererProps) {
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
      <GenericRenderer body={body} related={related} onRaw={onRaw} />
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
  instructions: InstructionsRenderer,
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
    hasFormattedView(event: TraceEvent, body: TraceBody | null | undefined): boolean {
      if (!body) return false;
      return (
        body.type !== "data" ||
        custom.has(event.template) ||
        (event.template === "usage" && event.usage !== null)
      );
    },
    resolve(template: string): TraceRenderer {
      return templates.get(template) ?? GenericRenderer;
    },
    templates: Object.freeze([...templates.keys()]),
  });
}
export const defaultTraceRenderers = createTraceRendererRegistry();
export type TraceRendererRegistry = ReturnType<typeof createTraceRendererRegistry>;
