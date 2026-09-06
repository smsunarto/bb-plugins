import { useState } from "react";

function Scalar({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const text = JSON.stringify(value) ?? String(value);
  const long = text.length > 2000;
  const kind = value === null ? "null" : typeof value;
  return (
    <span className={`tr-json-${kind}`}>
      {long && !expanded ? `${text.slice(0, 2000)}…` : text}
      {long && (
        <button className="tr-text-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Collapse string" : `Show ${text.length.toLocaleString()} characters`}
        </button>
      )}
    </span>
  );
}

function JsonNode({ value, depth, name }: { value: unknown; depth: number; name?: string }) {
  const [count, setCount] = useState(40);
  const [open, setOpen] = useState(depth < 2);
  if (value === null || typeof value !== "object") {
    return (
      <div className="tr-json-leaf">
        {name !== undefined && <span className="tr-json-key">{JSON.stringify(name)}: </span>}
        <Scalar value={value} />
      </div>
    );
  }
  const array = Array.isArray(value);
  const keys = Object.keys(value);
  const entries = open
    ? keys.slice(0, count).map((key) => [key, (value as Record<string, unknown>)[key]] as const)
    : [];
  return (
    <div className="tr-json-node">
      <button className="tr-json-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        {name !== undefined && <span className="tr-json-key">{JSON.stringify(name)}: </span>}
        <span>{array ? "[" : "{"}</span>
        <span className="tr-muted">
          {keys.length} {array ? "items" : "keys"}
        </span>
        {!open && <span>{array ? "]" : "}"}</span>}
      </button>
      {open && (
        <div className="tr-json-children">
          {entries.map(([key, item]) => (
            <JsonNode key={key} value={item} name={key} depth={depth + 1} />
          ))}
          {keys.length > count && (
            <button className="tr-text-button" onClick={() => setCount(count + 40)}>
              Show next {Math.min(40, keys.length - count)} of {keys.length - count} remaining
            </button>
          )}
          <div>{array ? "]" : "}"}</div>
        </div>
      )}
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  return (
    <div className="tr-json">
      <JsonNode value={value} depth={0} />
    </div>
  );
}
