import { posix } from "node:path";
import { pluginRelative, relativeImport } from "./shared.ts";

export type RuntimeZone = "app" | "server" | "host" | "shared" | "shared-node";
export type UnitKind = "rpc" | "command" | "tools";

/** Plugin-root-relative POSIX path. Built only through pluginPath. */
export type PluginPath = string & { readonly __pluginPath: unique symbol };

/**
 * bb.server after parse. Always `src/server/<file>.ts`.
 * `src/server.ts` and `server/server.ts` cannot be constructed.
 */
export type CompositionRoot = PluginPath & { readonly __compositionRoot: unique symbol };

/**
 * A bb-kit plugin tree. sourceRoot is the literal `"src"` so a prefix-less
 * kit layout cannot be typed. compositionRoot comes from the manifest.
 * hostEntry, rpcBridge, and appEntry are derived from sourceRoot, never
 * copied from package.json.
 */
export type SrcLayout = {
  readonly sourceRoot: "src";
  readonly compositionRoot: CompositionRoot;
  readonly hostEntry: PluginPath;
  readonly rpcBridge: PluginPath;
  readonly appEntry: PluginPath;
};

export type LocatedFile =
  | { kind: "owned"; zone: RuntimeZone; path: PluginPath }
  | { kind: "loose-src"; path: PluginPath }
  | { kind: "displaced"; zone: RuntimeZone; path: PluginPath }
  | { kind: "outside"; path: PluginPath };

export type LayoutError = { ok: false; message: string; path?: string };
export type LayoutOk = { ok: true; value: SrcLayout };
export type LayoutResult = LayoutOk | LayoutError;

export type RootEntryClass = "source-prefix" | "displaced-runtime" | "other";

const SOURCE_ROOT = "src" as const;
const DEFAULT_COMPOSITION = "src/server/server.ts";
const ZONE_NAMES = new Set<string>(["app", "server", "host", "shared"]);

export function pluginPath(raw: string): PluginPath {
  return pluginRelative(raw) as PluginPath;
}

function readServerField(pkg: unknown): string | undefined {
  if (pkg === undefined || pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
    return undefined;
  }
  const bb = (pkg as Record<string, unknown>)["bb"];
  if (bb === undefined || bb === null || typeof bb !== "object" || Array.isArray(bb)) {
    return undefined;
  }
  const server = (bb as Record<string, unknown>)["server"];
  if (typeof server !== "string" || server === "") {
    return undefined;
  }
  return server;
}

/** Root `./server.ts` SDK plugins. Detected before SrcLayout is built. */
export function isLegacySdkPlugin(pkg: unknown): boolean {
  const server = readServerField(pkg);
  if (server === undefined) {
    return false;
  }
  const relative = pluginPath(server);
  return posix.dirname(relative) === "." && relative.endsWith(".ts");
}

function makeLayout(compositionRoot: CompositionRoot): SrcLayout {
  return {
    sourceRoot: SOURCE_ROOT,
    compositionRoot,
    hostEntry: pluginPath(posix.join(SOURCE_ROOT, "host/host.ts")),
    rpcBridge: pluginPath(posix.join(SOURCE_ROOT, "app/rpc.ts")),
    appEntry: pluginPath(posix.join(SOURCE_ROOT, "app/app.tsx")),
  };
}

function zoneFromSegments(segments: readonly string[]): RuntimeZone | undefined {
  if (segments[0] === "shared" && segments[1] === "node") {
    return "shared-node";
  }
  const [head] = segments;
  if (head === "app" || head === "server" || head === "host" || head === "shared") {
    return head;
  }
  return undefined;
}

function isLayoutError(value: CompositionRoot | LayoutError): value is LayoutError {
  return typeof value === "object" && value !== null && "ok" in value;
}

function asCompositionRoot(path: PluginPath): CompositionRoot | LayoutError {
  if (path.startsWith("..") || posix.isAbsolute(path)) {
    return { ok: false, message: `bb.server "${path}" escapes the package`, path: "package.json" };
  }
  if (!path.endsWith(".ts") || path.endsWith(".d.ts")) {
    return {
      ok: false,
      message: `bb.server must be a .ts file under ${SOURCE_ROOT}/server/`,
      path: "package.json",
    };
  }
  const segments = path.split("/").filter((part) => part !== "");
  if (segments[0] !== SOURCE_ROOT) {
    return {
      ok: false,
      message: `bb.server must live under ${SOURCE_ROOT}/server/, got "${path}"`,
      path: "package.json",
    };
  }
  const rest = segments.slice(1);
  const zone = zoneFromSegments(rest);
  if (zone !== "server" || posix.dirname(path) === SOURCE_ROOT) {
    return {
      ok: false,
      message: `bb.server must be ${SOURCE_ROOT}/server/<file>.ts, got "${path}"`,
      path: "package.json",
    };
  }
  return path as CompositionRoot;
}

/**
 * Manifest boundary. Reads bb.server, brands it as CompositionRoot, and
 * fills hostEntry, rpcBridge, and appEntry from sourceRoot.
 */
export function parseLayout(pkg: unknown): LayoutResult {
  const server = readServerField(pkg);
  if (server === undefined) {
    return { ok: false, message: "bb.server is required", path: "package.json" };
  }
  const path = pluginPath(server);
  const root = asCompositionRoot(path);
  if (isLayoutError(root)) {
    return root;
  }
  return { ok: true, value: makeLayout(root) };
}

/** Scaffold and unreadable-package fallback. Always `src/server/server.ts`. */
export function defaultLayout(): SrcLayout {
  const root = asCompositionRoot(pluginPath(DEFAULT_COMPOSITION));
  if (isLayoutError(root)) {
    throw new Error(root.message);
  }
  return makeLayout(root);
}

export function locate(layout: SrcLayout, path: string): LocatedFile {
  const relative = pluginPath(path);
  const segments = relative.split("/").filter((part) => part !== "");
  if (segments[0] === layout.sourceRoot) {
    const zone = zoneFromSegments(segments.slice(1));
    if (zone === undefined) {
      return { kind: "loose-src", path: relative };
    }
    return { kind: "owned", zone, path: relative };
  }
  const zone = zoneFromSegments(segments);
  if (zone !== undefined) {
    return { kind: "displaced", zone, path: relative };
  }
  return { kind: "outside", path: relative };
}

export function unitDir(layout: SrcLayout, kind: UnitKind): PluginPath {
  return pluginPath(posix.join(posix.dirname(layout.compositionRoot), kind));
}

export function unitFile(layout: SrcLayout, kind: UnitKind, basename: string): PluginPath {
  return pluginPath(posix.join(unitDir(layout, kind), `${basename}.ts`));
}

function stripImplExtension(path: string): string {
  return path.replace(/\.(?:js|ts)x?$/, "");
}

export function isTypeEdge(
  layout: SrcLayout,
  from: string,
  to: string,
  typeOnly: boolean,
): boolean {
  if (!typeOnly) {
    return false;
  }
  const source = pluginPath(from);
  const target = pluginPath(to);
  if (source !== layout.rpcBridge) {
    return false;
  }
  if (stripImplExtension(target) !== stripImplExtension(layout.compositionRoot)) {
    return false;
  }
  const fromLocated = locate(layout, source);
  const toLocated = locate(layout, target);
  return (
    fromLocated.kind === "owned" &&
    fromLocated.zone === "app" &&
    toLocated.kind === "owned" &&
    toLocated.zone === "server"
  );
}

export function classifyRootEntry(layout: SrcLayout, name: string): RootEntryClass {
  if (name === layout.sourceRoot) {
    return "source-prefix";
  }
  if (ZONE_NAMES.has(name)) {
    return "displaced-runtime";
  }
  return "other";
}

/** Type-only import specifier from the RPC bridge to the composition root. */
export function typeEdgeSpecifier(layout: SrcLayout): string {
  return relativeImport(layout.rpcBridge, layout.compositionRoot);
}
