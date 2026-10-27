// Comment identity: the visible header a human reads, and the hidden marker
// the plugin matches on.
//
// Two independent signals on purpose. The marker is the machine contract —
// exact, unambiguous, invisible in rendered markdown. The header is the human
// contract, and doubles as a fallback attribution when an agent drops the
// marker: a body with the header but no marker is still provably ours, just
// flagged as prompt drift.
//
// The header is NOT authoritative for matching. It is ordinary editable text
// that anyone can type into a comment; only the marker is treated as proof.
import type { CommentKind } from "./types";

export interface Marker {
  rule: string;
  run: string;
  sha: string;
  kind: CommentKind;
}

const MARKER_PATTERN = /<!--\s*slopcop:([^>]*?)\s*-->/;

/** Values are constrained so a rule name can never break out of the marker. */
function sanitize(value: string): string {
  return value.replace(/[^\w.\-/]/g, "_");
}

export function buildMarker(marker: Marker): string {
  const fields = [
    `rule=${sanitize(marker.rule)}`,
    `run=${sanitize(marker.run)}`,
    `sha=${sanitize(marker.sha)}`,
    `kind=${marker.kind}`,
  ];
  return `<!-- slopcop:${fields.join(" ")} -->`;
}

export function parseMarker(body: string): Marker | null {
  const match = MARKER_PATTERN.exec(body);
  if (match === null) return null;
  const fields = new Map<string, string>();
  for (const pair of match[1]!.trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    fields.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const rule = fields.get("rule");
  const run = fields.get("run");
  const kind = fields.get("kind");
  if (
    rule === undefined ||
    run === undefined ||
    (kind !== "summary" && kind !== "inline" && kind !== "reply")
  ) {
    return null;
  }
  return { rule, run, sha: fields.get("sha") ?? "", kind };
}

/**
 * The summary gets the full banner; inline comments and replies get a compact
 * one-liner. A full banner on each of six inline comments buries the finding
 * that is the actual point of the comment.
 */
export function buildHeader(kind: CommentKind, ruleName: string): string {
  if (kind === "summary") {
    return `🚨 **SLOP COP** 🚨 · \`${ruleName}\``;
  }
  return `🚨 \`slopcop/${ruleName}\` —`;
}

/**
 * Detects our visible header. Deliberately loose about the rule name: a body
 * that says SLOP COP is ours even if the agent mangled the rule slug, and
 * treating it as ours is what turns an unattributable comment into a warning.
 */
export function hasVisibleHeader(body: string): boolean {
  return /🚨\s*(\*\*)?\s*SLOP\s*COP|🚨\s*`?slopcop\//i.test(body);
}

/** Wraps an agent-authored body in the header and marker. */
export function decorateBody(body: string, kind: CommentKind, marker: Marker): string {
  const header = buildHeader(kind, marker.rule);
  const trimmed = body.trim();
  const lead = kind === "summary" ? `${header}\n\n${trimmed}` : `${header} ${trimmed}`;
  return `${lead}\n\n${buildMarker(marker)}`;
}

export type Attribution = "marker" | "header" | "account" | null;

/**
 * How confidently a body can be attributed to a given run. `runId` scopes
 * marker matches so a previous run's comments are never counted as this one's.
 */
export function attributeBody(body: string, runId: string): Attribution {
  const marker = parseMarker(body);
  if (marker !== null) return marker.run === runId ? "marker" : null;
  if (hasVisibleHeader(body)) return "header";
  return null;
}
