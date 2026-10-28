// Where a Table's, Chart's or Metric's numbers come from: the `source:` the
// model wrote, else the files its data was Loaded from (`loadedFrom`, set by
// the evaluator). Shared by the caption under the component and its markdown.
import type { Value } from "./types";

export type SourceCaption =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "url"; readonly url: URL; readonly label: string }
  | { readonly kind: "files"; readonly paths: readonly string[] };

/** The caption for a component's props; null when it has none (`source: ""` hides the automatic one). */
export function sourceCaption(props: Readonly<Record<string, Value | undefined>>): SourceCaption | null {
  if (typeof props.source === "string") {
    const text = props.source.trim().replace(/\s+/g, " ");
    if (text === "") return null;
    const url = /^https:\/\/\S+$/i.test(text) ? parseUrl(text) : null;
    return url === null ? { kind: "text", text } : { kind: "url", url, label: urlLabel(url) };
  }
  const paths = Array.isArray(props.loadedFrom) ? props.loadedFrom.filter((path): path is string => typeof path === "string") : [];
  return paths.length === 0 ? null : { kind: "files", paths };
}

/** Equal captions, so a row of Metrics from one file names it once. */
export function sameCaption(a: SourceCaption | null, b: SourceCaption | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "text" && b.kind === "text") return a.text === b.text;
  if (a.kind === "url" && b.kind === "url") return a.url.href === b.url.href;
  if (a.kind === "files" && b.kind === "files") return a.paths.length === b.paths.length && a.paths.every((path, index) => path === b.paths[index]);
  return false;
}

/**
 * A loaded file as the caption names it: a workspace path as written, and
 * only the file name of a thread-storage or absolute path, whose folders
 * say nothing to the reader.
 */
export function sourceFileLabel(path: string): string {
  if (!/^(\$BB_THREAD_STORAGE\/|\/|~\/|[A-Za-z]:[\\/])/.test(path)) return path;
  return path.split(/[\\/]/).filter((part) => part !== "").pop() ?? path;
}

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** `npmjs.com/advisories/1234`: the host without `www.` and the path, no scheme. */
function urlLabel(url: URL): string {
  const path = url.pathname === "/" ? "" : decodeSafe(url.pathname).replace(/\/$/, "");
  return `${url.host.replace(/^www\./i, "")}${path}`;
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
