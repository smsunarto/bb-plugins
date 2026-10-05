import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type {
  ReviewCanvasBridge,
  ReviewDiffViewFactory,
  ReviewDiffViewHandle,
  ReviewInlineEditorFactory,
  ReviewRuntimeConfig,
  ReviewSourceView,
} from "../../shared/vendor/review-protocol/src/index.ts";
import type { InfoOutput } from "../../shared/contracts/api-tunnel.ts";
import type { WhiteboardRpcClient } from "../rpc.ts";
import { LIBAVOID_WASM } from "../vendor/generated/libavoid-wasm.ts";
import { createDiffView } from "./diff-view.tsx";
import type { SurfaceEvents } from "./events.ts";
import { createInlineEditors } from "./inline-editors.tsx";
import type { LiveHub } from "./live-watch.ts";
import type { Portals } from "./portals.tsx";
import {
  currentDiffLayout,
  currentTheme,
  onDidChangeDiffLayout,
  onDidChangeTheme,
  setDiffLayout,
} from "./theme.ts";
import { createTooltips } from "./tooltip.tsx";
import { createTunnel } from "./tunnel.ts";
import { createLiveFileOpener, createVerbs } from "./verbs.ts";

/** What a mount hands the bridge. */
export type BbBridgeDeps = {
  rpc: WhiteboardRpcClient;
  /** The panel's thread; absent on the Home navPanel. */
  threadId?: string;
  reviewId?: string;
  navigate: BbNavigate;
  info: InfoOutput;
  portals: Portals;
  events: SurfaceEvents;
  /** Realtime invalidations for live watch streams. */
  hub: LiveHub;
  sourceView?: () => ReviewSourceView | undefined;
};

/**
 * Satisfies the runtime-config schema shape. Nothing parses it at runtime and
 * the tunnel strips the origin (design §3.8).
 */
export const PLACEHOLDER_SERVER_URL = "http://127.0.0.1:1";

let wasmUrl: string | undefined;

/** `bb plugin build` has no wasm loader, so libavoid ships as base64 and becomes a blob URL once. */
export function libavoidWasmUrl(): string {
  if (wasmUrl) return wasmUrl;
  const binary = atob(LIBAVOID_WASM);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  wasmUrl = URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
  return wasmUrl;
}

/**
 * WP6's factories are created on first use. A failure there then breaks one
 * code surface, not the whole canvas.
 */
function lazy<T>(create: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= create());
}

/** The bb implementation of upstream `ReviewCanvasBridge` (design §3.8). */
export function createBbBridge(deps: BbBridgeDeps): ReviewCanvasBridge {
  const { rpc, threadId, reviewId, navigate, portals, events, hub } = deps;
  const request = createTunnel({ rpc, threadId, hub });

  const notify: NonNullable<ReviewCanvasBridge["notify"]> = (message) => {
    if (message.kind === "error") toast.error(message.text);
    else toast.success(message.text);
  };
  const openFile = createLiveFileOpener({ rpc, navigate, notify });
  const surfaces = { request, reviewId, portals, sourceView: deps.sourceView, openFile };

  const inlineEditorFactory = lazy(() => createInlineEditors(surfaces));
  const inlineEditors: ReviewInlineEditorFactory = {
    create: (spec) => inlineEditorFactory().create(spec),
    find: (spec, query) => inlineEditorFactory().find(spec, query),
  };

  // openDiff names a file before the Diffs view may exist; the next handle reveals it.
  let diffHandle: ReviewDiffViewHandle | undefined;
  let pendingReveal: string | undefined;
  const diffViewFactory = lazy(() => createDiffView(surfaces));
  const diffView: ReviewDiffViewFactory = {
    create(spec) {
      const inner = diffViewFactory().create(spec);
      // Forward, never mutate: WP6 owns the handle's shape. Optional members
      // stay absent when the inner handle lacks them.
      const handle: ReviewDiffViewHandle = {
        focus: () => inner.focus(),
        onDidError: (listener) => inner.onDidError(listener),
        dispose() {
          if (diffHandle === handle) diffHandle = undefined;
          inner.dispose();
        },
        ...(inner.setProgress && { setProgress: (progress) => inner.setProgress?.(progress) }),
        ...(inner.revealSource && {
          revealSource: (source, sectionId) => inner.revealSource?.(source, sectionId),
        }),
        ...(inner.revealFile && { revealFile: (path) => inner.revealFile?.(path) }),
        ...(inner.onDidScroll && { onDidScroll: (listener) => inner.onDidScroll!(listener) }),
        ...(inner.sourceOffset && { sourceOffset: (source) => inner.sourceOffset?.(source) }),
      };
      diffHandle = handle;
      if (pendingReveal !== undefined) {
        handle.revealFile?.(pendingReveal);
        pendingReveal = undefined;
      }
      return handle;
    },
    files: (scope) => diffViewFactory().files(scope),
  };

  const config: ReviewRuntimeConfig = {
    host: "desktop",
    serverUrl: PLACEHOLDER_SERVER_URL,
    token: "",
    reviewId: reviewId ?? "home",
    theme: currentTheme(),
    appVersion: deps.info.appVersion || "0.0.0",
    get wasmUrl() {
      return libavoidWasmUrl();
    },
  };

  return {
    config,
    inlineEditors,
    diffView,
    request,
    post: createVerbs({
      navigate,
      threadId,
      reviewId,
      request,
      events,
      notify,
      revealDiffFile(path) {
        if (diffHandle?.revealFile) diffHandle.revealFile(path);
        else pendingReveal = path;
      },
      openFile,
      sourceView: deps.sourceView,
      // Read per call: a mount may pass a live getter for settings changes.
      softwareMapEnabled: () => deps.info.softwareMapEnabled,
    }),
    subscribe(listener) {
      const surface = events.subscribe(listener);
      // Desktop pushes theme changes as a surface event (debug-settings.tsx
      // keys diagrams' color mode on it). bb's arrive as a class on <html>.
      const theme = onDidChangeTheme((next) => listener({ event: "themeChanged", theme: next }));
      return {
        dispose() {
          surface.dispose();
          theme.dispose();
        },
      };
    },
    currentTheme,
    onDidChangeTheme,
    currentDiffLayout,
    setDiffLayout,
    onDidChangeDiffLayout,
    notify,
    setupTooltip: createTooltips(portals),
    ready() {},
    reportDiagnostic(diagnostic) {
      const log = diagnostic.level === "error" ? console.error : console.warn;
      log(`[whiteboard] ${diagnostic.source}: ${diagnostic.message}`, diagnostic.stack ?? "");
    },
  };
}
