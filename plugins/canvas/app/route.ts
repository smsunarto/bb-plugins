import type { CanvasSource } from "../shared/source.ts";

// The canvas page lives at `/plugins/canvas/canvas/<subPath>`. The sub-path
// carries the whole file identity as one opaque base64url segment, so the
// host's per-segment URL encoding and decoding cannot alter it.

export const PLUGIN_ID = "canvas";
export const PANEL_PATH = "canvas";

interface RouteRecord {
  readonly k: CanvasSource["kind"];
  readonly id: string | null;
  readonly p: string;
}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string | null {
  if (text.length === 0 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded =
    text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function idOf(source: CanvasSource): string | null {
  switch (source.kind) {
    case "workspace":
      return source.environmentId;
    case "thread-storage":
      return source.threadId;
    case "host":
      return source.hostId;
  }
}

export function encodeCanvasSubPath(source: CanvasSource): string {
  const record: RouteRecord = { k: source.kind, id: idOf(source), p: source.path };
  return toBase64Url(JSON.stringify(record));
}

export function decodeCanvasSubPath(subPath: string): CanvasSource | null {
  const text = fromBase64Url(subPath.trim());
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { k, id, p } = parsed as Partial<Record<keyof RouteRecord, unknown>>;
  if (typeof p !== "string" || p.length === 0) return null;
  const nonEmptyId = typeof id === "string" && id.length > 0 ? id : null;
  switch (k) {
    case "workspace":
      return nonEmptyId === null ? null : { kind: "workspace", environmentId: nonEmptyId, path: p };
    case "thread-storage":
      return nonEmptyId === null ? null : { kind: "thread-storage", threadId: nonEmptyId, path: p };
    case "host":
      return { kind: "host", hostId: nonEmptyId, path: p };
    default:
      return null;
  }
}

export function canvasPanelRoute(source: CanvasSource): string {
  return `/plugins/${PLUGIN_ID}/${PANEL_PATH}/${encodeCanvasSubPath(source)}`;
}
