import type { ParsedEvent, SessionPatch, TraceEvidence } from "../model";

export type ObjectRecord = Record<string, unknown>;

export function object(value: unknown): ObjectRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectRecord)
    : {};
}

export function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function timestamp(value: unknown): number | null {
  if (typeof value === "number") return finite(value);
  if (typeof value !== "string") return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

export function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export function pointer(base: string, key: string | number): string {
  return `${base}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

export function contentText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (depth > 6) return "";
  if (Array.isArray(value))
    return value
      .map((item) => contentText(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  const item = object(value);
  return string(item.text) ?? string(item.thinking) ?? contentText(item.content, depth + 1);
}

export function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "[Unserializable record]";
  }
}

export function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function fact(
  topic: TraceEvidence["topic"],
  action: TraceEvidence["action"],
  label: string,
  at: string,
  basis: TraceEvidence["basis"] = "recorded",
): TraceEvidence {
  return { topic, action, label: clip(label, 256), basis, pointer: at };
}

export function evidence(items: TraceEvidence[]): TraceEvidence[] {
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = `${item.topic}\0${item.action}\0${item.label}\0${item.pointer}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 64);
}

export function event(record: ObjectRecord, fields: Partial<ParsedEvent>): ParsedEvent {
  const payload = object(record.payload);
  const result: ParsedEvent = {
    kind: "diagnostic",
    role: null,
    title: "Unrecognized record",
    preview: "",
    timestamp: timestamp(record.timestamp),
    template: "data",
    nativeId: string(record.uuid) ?? string(payload.id) ?? string(record.id),
    parentId: string(record.parentUuid) ?? string(payload.parent_id) ?? string(record.parent_id),
    turnId: string(payload.turn_id) ?? string(record.turn_id),
    tool: null,
    usage: null,
    evidence: [],
    pointer: "",
    body: { type: "data", value: record },
    ...fields,
  };
  result.title = clip(result.title, 160);
  result.preview = clip(result.preview.replaceAll("\u0000", ""), 2048);
  result.evidence = evidence(
    result.evidence.map((item) => ({ ...item, label: clip(item.label, 256) })),
  );
  return result;
}

export function diagnostic(value: unknown, label = "Unrecognized record"): ParsedEvent {
  return event(object(value), {
    title: label,
    preview: clip(json(value), 2048),
    body: { type: "data", value },
  });
}

export const MAX_PARTS = 256;

export function overflowParts(record: ObjectRecord, values: unknown[], at: string): ParsedEvent[] {
  return values.length <= MAX_PARTS
    ? []
    : [
        event(record, {
          title: "Additional content parts",
          preview: `${values.length - MAX_PARTS} additional parts remain in the recorded payload.`,
          pointer: at,
          body: { type: "data", value: values },
        }),
      ];
}

export function baseSession(record: ObjectRecord): SessionPatch {
  const session: SessionPatch = {};
  const nativeId = string(record.sessionId);
  const cwd = string(record.cwd);
  const model = string(record.model) ?? string(object(record.message).model);
  if (nativeId) session.nativeId = nativeId;
  if (cwd) session.cwd = cwd;
  if (model) session.model = model;
  const agentId = string(record.agentId);
  if (record.isSidechain === true && nativeId && agentId) {
    session.nativeId = `${nativeId}/agent/${agentId}`;
    session.parentNativeId = nativeId;
  }
  return session;
}

export function rootPath(home: string, override: string | undefined, suffix: string): string {
  const configured = override?.trim();
  const base = configured
    ? configured === "~"
      ? home
      : configured.startsWith("~/")
        ? `${home}/${configured.slice(2)}`
        : configured
    : home;
  return `${base.replace(/\/+$/, "")}/${suffix}`;
}

function catalogEvidence(text: string, at: string, basis: TraceEvidence["basis"]): TraceEvidence[] {
  const facts: TraceEvidence[] = [];
  for (const [heading, topic] of [
    ["skills", "skills"],
    ["plugins", "plugins"],
  ] as const) {
    const match = new RegExp(`^#{1,6}\\s+Available ${heading}\\s*$`, "im").exec(text);
    if (!match) continue;
    const section = text.slice(match.index + match[0].length).split(/^#{1,6}\s/m)[0] ?? "";
    for (const line of section.split("\n")) {
      const name = /^\s*[-*]\s+([^\s:]+)(?:\s|:|$)/.exec(line)?.[1];
      if (name) facts.push(fact(topic, "available", name, at, basis));
      if (facts.length >= 64) break;
    }
  }
  return facts;
}

export function contextEvidence(
  text: string,
  at: string,
  role: ParsedEvent["role"],
): TraceEvidence[] {
  if (role !== "developer" && role !== "system" && role !== "user") return [];
  const facts: TraceEvidence[] = [];
  const authoritative = role === "developer" || role === "system";
  const injected =
    role === "user" &&
    /^\s*(?:# AGENTS\.md instructions for [^\n]+\s+)?<(?:system-reminder|INSTRUCTIONS)>/.test(text);
  const recordedInstructions =
    authoritative || (injected && /(?:AGENTS|CLAUDE)\.md|instructions/i.test(text));
  if (recordedInstructions) facts.push(fact("instructions", "loaded", "Recorded instructions", at));
  else if (/^#{1,6}\s+(?:AGENTS|CLAUDE)\.md\b/m.test(text)) {
    facts.push(
      fact("instructions", "reference", "Instruction document in message", at, "inferred"),
    );
  }
  const capturedContext = authoritative || injected;
  if (capturedContext || /^\s*#{1,6}\s+Available (?:skills|plugins)\s*\n/i.test(text))
    facts.push(...catalogEvidence(text, at, capturedContext ? "recorded" : "inferred"));
  return evidence(facts);
}

export function textEvent(
  record: ObjectRecord,
  text: string,
  role: ParsedEvent["role"],
  at: string,
): ParsedEvent {
  const facts = contextEvidence(text, at, role);
  const instructions = facts.some(
    (item) => item.topic === "instructions" && item.action === "loaded",
  );
  const context = instructions || facts.some((item) => item.action === "available");
  return event(record, {
    kind: context ? "context" : "message",
    role,
    title: instructions ? "Instructions" : context ? "Recorded context" : (role ?? "Message"),
    preview: text,
    pointer: at,
    template: instructions ? "instructions" : context ? "context" : "message",
    evidence: facts,
    body: context
      ? {
          type: "context",
          name: instructions ? "Recorded instructions" : "Recorded context",
          content: text,
          format: "markdown",
          captured: true,
        }
      : { type: "text", text, format: "markdown" },
  });
}
