// Defensive readers for evaluated props. The core normalizes params by kind,
// but plain objects in a spec can mimic node/action shapes, so every reader
// checks the shape it relies on instead of trusting the declared kind.
import type { Action, Binding, Scalar, UiNode, Value } from "../core/types";

export type Props = Readonly<Record<string, Value>>;

/** The one object guard of the renderer; callers still check each field. */
export function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNode(value: unknown): value is UiNode {
  return (
    isObject(value) &&
    value.kind === "node" &&
    typeof value.type === "string" &&
    typeof value.key === "string" &&
    isObject(value.props)
  );
}

export function isBinding(value: unknown): value is Binding {
  return (
    isObject(value) &&
    value.kind === "binding" &&
    typeof value.name === "string" &&
    "value" in value
  );
}

export function isAction(value: unknown): value is Action {
  if (!isObject(value) || value.kind !== "action") return false;
  switch (value.type) {
    case "send":
    case "copy":
      return typeof value.text === "string";
    case "openUrl":
      return typeof value.url === "string";
    case "set":
      return typeof value.name === "string" && "value" in value;
    default:
      return false;
  }
}

export function isScalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** A `string` param: scalars become strings, anything else is empty. */
export function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** An optional `string` param: absent or null stays null. */
export function optionalText(value: unknown): string | null {
  return value === undefined || value === null ? null : text(value);
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function list(value: Value | undefined): readonly Value[] {
  return Array.isArray(value) ? value : [];
}

export function nodes(value: Value | undefined): UiNode[] {
  return list(value).filter(isNode);
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";

/** BB's timeline accent (a muted blue in the stock themes), else the primary ink. */
export const ACCENT = "var(--color-timeline-accent,var(--primary))";

/** Text color per tone; neutral inherits. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "",
  good: "text-success",
  warn: "text-warning-text",
  bad: "text-destructive",
  info: "text-[var(--color-timeline-accent,var(--primary))]",
};

/** Status-dot fill per tone. */
export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground/45",
  good: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  info: "bg-[var(--color-timeline-accent,var(--primary))]",
};

/** Pill surface per tone: a faint wash of the tone, no border. */
export const TONE_PILL: Record<Tone, string> = {
  neutral: "bg-surface-recessed text-muted-foreground",
  good: "bg-success/12 text-success",
  warn: "bg-warning/14 text-warning-text",
  bad: "bg-destructive/10 text-destructive",
  info: "bg-[color-mix(in_oklch,var(--color-timeline-accent,var(--primary))_12%,transparent)] text-[var(--color-timeline-accent,var(--primary))]",
};

export function tone(value: Value | undefined): Tone {
  return typeof value === "string" && Object.hasOwn(TONE_TEXT, value)
    ? (value as Tone)
    : "neutral";
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

/** Locale-independent grouping, up to 2 decimals (matches `fmt`). */
export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}
