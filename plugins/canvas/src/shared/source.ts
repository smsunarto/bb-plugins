import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk";

// Browser-safe identity helpers. This module stays zod-free so the app can
// import it as a value while `document.ts` and `registry.ts` stay type-only.

export type CanvasSource =
  | { readonly kind: "workspace"; readonly environmentId: string; readonly path: string }
  | { readonly kind: "thread-storage"; readonly threadId: string; readonly path: string }
  | { readonly kind: "host"; readonly hostId: string; readonly path: string };

/**
 * A host path bb opened without naming its host. The path is on the host of
 * the environment or thread that opened it, which is rarely the server's, so
 * the opener looks the host up before it reads anything.
 */
export interface HostLookup {
  readonly kind: "host-lookup";
  readonly owner:
    | { readonly environmentId: string; readonly threadId: null }
    | { readonly environmentId: null; readonly threadId: string };
  readonly path: string;
}

export type NarrowSourceResult =
  | { readonly ok: true; readonly value: CanvasSource | HostLookup }
  | {
      readonly ok: false;
      readonly reason: "no-environment" | "no-thread" | "no-host" | "empty-path";
    };

function present(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.length > 0;
}

export function narrowSource(source: PluginFileOpenerSource, path: string): NarrowSourceResult {
  if (path.length === 0) return { ok: false, reason: "empty-path" };
  switch (source.kind) {
    case "workspace": {
      if (!present(source.environmentId)) return { ok: false, reason: "no-environment" };
      return { ok: true, value: { kind: "workspace", environmentId: source.environmentId, path } };
    }
    case "thread-storage": {
      if (!present(source.threadId)) return { ok: false, reason: "no-thread" };
      return { ok: true, value: { kind: "thread-storage", threadId: source.threadId, path } };
    }
    case "host": {
      if (present(source.experimental_hostId)) {
        return { ok: true, value: { kind: "host", hostId: source.experimental_hostId, path } };
      }
      const owner = present(source.environmentId)
        ? { environmentId: source.environmentId, threadId: null }
        : present(source.threadId)
          ? { environmentId: null, threadId: source.threadId }
          : null;
      if (owner === null) return { ok: false, reason: "no-host" };
      return { ok: true, value: { kind: "host-lookup", owner, path } };
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
      return ["host", source.hostId, path].join("\0");
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

export interface CommentsSignal {
  readonly sidecarPath: string;
  readonly sha256: string;
}

export const commentsChannel = "canvas:comments";
