import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk";

// Browser-safe identity helpers. This module stays zod-free so the app can
// import it as a value while `document.ts` and `registry.ts` stay type-only.

export type CanvasSource =
  | { readonly kind: "workspace"; readonly environmentId: string; readonly path: string }
  | { readonly kind: "thread-storage"; readonly threadId: string; readonly path: string }
  | { readonly kind: "host"; readonly hostId: string | null; readonly path: string };

export type NarrowSourceResult =
  | { readonly ok: true; readonly value: CanvasSource }
  | { readonly ok: false; readonly reason: "no-environment" | "no-thread" | "empty-path" };

export function narrowSource(source: PluginFileOpenerSource, path: string): NarrowSourceResult {
  if (path.length === 0) return { ok: false, reason: "empty-path" };
  switch (source.kind) {
    case "workspace": {
      if (source.environmentId === null || source.environmentId.length === 0) {
        return { ok: false, reason: "no-environment" };
      }
      return { ok: true, value: { kind: "workspace", environmentId: source.environmentId, path } };
    }
    case "thread-storage": {
      if (source.threadId === null || source.threadId.length === 0) {
        return { ok: false, reason: "no-thread" };
      }
      return { ok: true, value: { kind: "thread-storage", threadId: source.threadId, path } };
    }
    case "host": {
      const hostId =
        source.experimental_hostId !== undefined && source.experimental_hostId.length > 0
          ? source.experimental_hostId
          : null;
      return { ok: true, value: { kind: "host", hostId, path } };
    }
  }
}

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+/g, "/");
}

// Built from the source-relative identity so state stays put when the file
// is copied elsewhere, and so `state` never needs a host round-trip.
export function stateKeyOf(source: CanvasSource): string {
  const path = normalizePath(source.path);
  switch (source.kind) {
    case "workspace":
      return ["workspace", source.environmentId, path].join("\0");
    case "thread-storage":
      return ["thread-storage", source.threadId, path].join("\0");
    case "host":
      return ["host", source.hostId ?? "", path].join("\0");
  }
}

export function isCanvasPath(path: string): boolean {
  return /\.canvas\.mdx$/i.test(path);
}

export function fileNameOf(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

const statefulNames: ReadonlySet<string> = new Set(["Toggle", "Select", "Tabs", "Checklist"]);

// Mirrors `registry[name].stateful`; `registry.test.ts` keeps the two in sync.
export function isStatefulName(name: string): boolean {
  return statefulNames.has(name);
}

export interface StateSignal {
  readonly stateKey: string;
  readonly revision: number;
}

export const stateChannel = "canvas:state";
