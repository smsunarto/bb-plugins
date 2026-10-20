import {
  definePluginApp,
  experimental_usePluginId,
  Markdown,
  useBbNavigate,
  useSdk,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import {
  useEffect,
  useEffectEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";

import { Skeleton } from "@/components/ui/skeleton";
import "./app.css";
import {
  fetchInlineAsset,
  INLINE_ASSET_READY,
  type InlineAssetMessage,
  prepareInlineAssets,
  type InlinePreviewAsset,
} from "./inline-assets.ts";
import {
  FRAGMENT_MESSAGES,
  injectFragmentRuntime,
  isFragment,
  parseFrameMessage,
  readHostTheme,
  sameTheme,
} from "./fragment-runtime.ts";
import { previewMarkdown } from "./preview-markdown.ts";
import { PREVIEW_FRAME_MESSAGES, previewFrameUrl } from "./preview-frame.ts";
import { createPreviewExpansion } from "./inline-vis-expansion.ts";
import { loadPreview } from "./load-preview.ts";
import { useRememberedHeight, videoSizes } from "./preview-sizes.ts";
import { loadVideoPlayer, mayNeedVideoPlayer, upgradeVideoPlayers } from "./video-player.ts";
import { TweakPanel } from "./tweak-panel.tsx";
import type { TweakGroup } from "./tweak-contract.ts";
import { useWidgetState } from "./use-widget-state.ts";

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      kind: "html";
      file: string;
      hostId: string;
      url: string;
      html?: string;
      assets: InlinePreviewAsset[];
      token?: string;
      fragment: boolean;
    }
  | {
      status: "ready";
      kind: "markdown";
      file: string;
      hostId: string;
      url: string;
      content: string;
    }
  | { status: "error"; message: string };

export const DEFAULT_HEIGHT_PX = 224;
export const MIN_HEIGHT_PX = 120;
export const MAX_HEIGHT_PX = 1_200;
/** Smallest content-sized fragment, so an empty one still shows its frame. */
const MIN_FRAGMENT_HEIGHT_PX = 40;

const fragmentHeight = (contentHeight: number) =>
  Math.min(MAX_HEIGHT_PX, Math.max(MIN_FRAGMENT_HEIGHT_PX, contentHeight));

const videoSizeStore = (pluginId: string) => videoSizes(`${pluginId}.inline-vis.video-sizes`);
const videoSizeKey = (preview: { hostId: string; file: string }, path: string) =>
  `${preview.hostId}\n${preview.file}\n${path}`;

export function parsePreviewHeight(value: string | undefined): number | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) return DEFAULT_HEIGHT_PX;
  if (!/^\d+$/u.test(normalized)) return null;
  const height = Number(normalized);
  return Number.isSafeInteger(height) && height >= MIN_HEIGHT_PX && height <= MAX_HEIGHT_PX
    ? height
    : null;
}

function PreviewHeader({
  file,
  expanded,
  onToggle,
  onOpen,
  onWide,
  wideTrigger,
}: {
  file: string;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (() => void) | null;
  onWide?: () => void;
  wideTrigger?: RefObject<HTMLButtonElement | null>;
}) {
  // Upstream #4507 and #4538: the whole row toggles in place, and opening the
  // file is a separate trailing action so the two never look alike.
  return (
    <figcaption className="inline-vis-header">
      <button
        type="button"
        className="inline-vis-toggle"
        aria-label={`${expanded ? "Collapse" : "Expand"} visualization ${file}`}
        aria-expanded={expanded}
        title={expanded ? "Collapse preview" : "Expand preview here"}
        onClick={onToggle}
      >
        <span className="inline-vis-label">inline-vis</span>
        <span className="inline-vis-path" title={file}>
          <bdi>{file}</bdi>
        </span>
        {/* Sized attributes keep icons small if they render before app.css applies. */}
        <svg
          aria-hidden="true"
          className="inline-vis-chevron"
          width="10"
          height="16"
          viewBox="0 0 10 16"
          fill="currentColor"
        >
          <path d="M.47 5.47a.75.75 0 0 1 1.06 0L5 8.94l3.47-3.47a.75.75 0 0 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06" />
        </svg>
      </button>
      {onWide ? (
        <button
          type="button"
          ref={wideTrigger}
          className="inline-vis-action inline-vis-icon"
          aria-label="Wide view"
          title="Wide view"
          onClick={onWide}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
      ) : (
        // Hold the slot while loading so the row does not shift when it appears.
        expanded && <span aria-hidden="true" className="inline-vis-action" />
      )}
      {onOpen === null ? (
        <span aria-hidden="true" className="inline-vis-action" />
      ) : (
        <button
          type="button"
          className="inline-vis-action inline-vis-icon inline-vis-open"
          aria-label={`Open ${file} in sidebar`}
          title="Open in sidebar"
          onClick={onOpen}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          </svg>
        </button>
      )}
    </figcaption>
  );
}

function Alert({
  source,
  children,
  error = false,
}: {
  source: string;
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      role="alert"
      className={`inline-vis-alert${error ? " inline-vis-alert-error" : ""}`}
      title={source}
    >
      {children}
    </div>
  );
}

function InlineVisDirective({
  attributes,
  source,
  message,
  openWorkspaceFile,
}: PluginMessageDirectiveProps) {
  const file = attributes.file?.trim() ?? "";
  const height = parsePreviewHeight(attributes.height);
  const previewSource = attributes.source?.trim();
  if (!file)
    return (
      <Alert source={source}>
        inline-vis requires a file attribute, e.g.{" "}
        <code>::inline-vis{'{file="/absolute/path/demo.html"}'}</code>
      </Alert>
    );
  if (previewSource !== undefined)
    return (
      <Alert source={source}>
        inline-vis no longer accepts source. Provide an absolute file path.
      </Alert>
    );
  if (height === null)
    return (
      <Alert source={source}>
        inline-vis height must be a whole number from {MIN_HEIGHT_PX} to {MAX_HEIGHT_PX} pixels.
      </Alert>
    );
  return (
    <CollapsiblePreview
      key={`${message.threadId}:${message.id}:${file}`}
      attributes={attributes}
      source={source}
      message={message}
      openWorkspaceFile={openWorkspaceFile}
    />
  );
}

function CollapsiblePreview(props: PluginMessageDirectiveProps) {
  const pluginId = experimental_usePluginId();
  const [expansion] = useState(() => createPreviewExpansion(`${pluginId}.inline-vis.collapsed`));
  const card = useRef<HTMLElement>(null);
  const expanded = useSyncExternalStore(expansion.subscribe, expansion.getSnapshot, () => false);
  useLayoutEffect(
    () => expansion.register(props.message.threadId, card.current!),
    [expansion, props.message.threadId],
  );
  return (
    <figure ref={card} className="inline-vis-card">
      {expanded ? (
        <ExpandedPreview {...props} onToggle={expansion.toggle} />
      ) : (
        <PreviewHeader
          file={props.attributes.file!.trim()}
          expanded={false}
          onToggle={expansion.toggle}
          onOpen={null}
        />
      )}
    </figure>
  );
}

function PreviewDocument({
  preview,
  frame,
  frameKey,
  height,
}: {
  preview: Extract<LoadState, { status: "ready" }>;
  frame: RefObject<HTMLIFrameElement | null>;
  frameKey: number;
  height: number;
}) {
  const pluginId = experimental_usePluginId();
  if (preview.kind === "markdown")
    return (
      <div style={{ height }} className="inline-vis-markdown">
        <Markdown content={preview.content} />
      </div>
    );
  return (
    <iframe
      key={frameKey}
      title={`inline-vis: ${preview.file}`}
      src={preview.html === undefined ? preview.url : previewFrameUrl(pluginId)}
      ref={frame}
      sandbox="allow-scripts"
      // The opaque frame needs this for a video player's fullscreen button.
      allow="fullscreen"
      style={{ height }}
      className="inline-vis-frame"
    />
  );
}

function useFragmentBridge(
  state: LoadState,
  frame: RefObject<HTMLIFrameElement | null>,
  updateState: (state: string, modelContent: string | null) => void,
  updateTweaks: (groups: TweakGroup[], changed: boolean, reset?: string | null) => void,
  addContext: (prompt?: string) => Promise<void>,
  leaveWide: () => void,
) {
  const pluginId = experimental_usePluginId();
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [tweaks, setTweaks] = useState<{ groups: TweakGroup[]; original: boolean }>({
    groups: [],
    original: false,
  });
  // Windows that already received a document. A frame keeps its window when it
  // navigates, so a window that asks again may now hold a page from elsewhere.
  const served = useRef(new WeakSet<Window>());
  const [frameKey, setFrameKey] = useState(0);
  const onMessage = useEffectEvent((event: MessageEvent) => {
    if (event.source !== frame.current?.contentWindow) return;
    if (state.status !== "ready" || state.kind !== "html" || !state.token) return;
    const data = parseFrameMessage(event.data, state.token);
    if (data?.type === "escape") {
      leaveWide();
      return;
    }
    if (!state.fragment) return;
    if (data?.type === "resize") setContentHeight(data.height);
    else if (data?.type === "state") {
      updateState(data.state, data.modelContent ?? null);
    } else if (data?.type === "tweak") {
      setTweaks({ groups: data.groups, original: data.original });
      updateTweaks(data.groups, data.changed, data.reset);
    }
    // A click inside the frame also activates this page. Without one, a
    // fragment script could fill the composer on load.
    else if (data?.type === "followUp" && navigator.userActivation?.isActive === true) {
      void addContext(data.prompt);
    }
  });
  useLayoutEffect(() => {
    if (state.status !== "ready" || state.kind !== "html" || state.html === undefined) return;
    const html = state.html;
    const deliver = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || event.data?.type !== PREVIEW_FRAME_MESSAGES.ready)
        return;
      // Each window gets the document once. One that asks again reloaded or
      // navigated back to the frame page, so a fresh frame replaces it.
      if (served.current.has(target)) {
        setFrameKey((key) => key + 1);
        return;
      }
      served.current.add(target);
      target.postMessage({ type: PREVIEW_FRAME_MESSAGES.document, html }, "*");
    };
    window.addEventListener("message", deliver);
    return () => window.removeEventListener("message", deliver);
  }, [state, frame]);
  const [assetError, setAssetError] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (
      state.status !== "ready" ||
      state.kind !== "html" ||
      !state.token ||
      state.assets.length === 0
    )
      return;
    const token = state.token;
    const controller = new AbortController();
    // Media downloads while the frame loads, and each asset goes to the frame
    // as soon as it settles. A fragmented MP4 also streams while it downloads.
    // Images take the link first: they are small and show on arrival.
    const sent = new Map<string, InlineAssetMessage[]>();
    let served: Window | null = null;
    let port: MessagePort | null = null;
    const send = (message: InlineAssetMessage) => {
      if (controller.signal.aborted) return;
      // A replacement frame needs a settled asset's outcome, or a streaming
      // one's bytes so far. Either way it needs the video's size first.
      const earlier = sent.get(message.key) ?? [];
      const log =
        "size" in message || "stream" in message || "chunk" in message
          ? earlier
          : earlier.filter((logged) => "size" in logged);
      log.push(message);
      sent.set(message.key, log);
      port?.postMessage(message);
    };
    const sizes = videoSizeStore(pluginId);
    const load = (asset: InlinePreviewAsset) =>
      fetchInlineAsset(asset, controller.signal, (message) => {
        if ("size" in message) sizes.write(videoSizeKey(state, asset.path), message.size);
        send(message);
      }).then(
        (blob) => send({ key: asset.key, blob }),
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setAssetError(
            (current) => current ?? (error instanceof Error ? error.message : String(error)),
          );
          send({ key: asset.key, failed: true });
        },
      );
    const { assets } = state;
    void (async () => {
      await Promise.all(assets.filter((asset) => asset.image).map(load));
      if (!controller.signal.aborted)
        await Promise.all(assets.filter((asset) => !asset.image).map(load));
    })();
    // Each frame window gets one port, from its first document. A replacement
    // frame announces itself again and gets everything settled so far.
    const ready = (event: MessageEvent) => {
      const source = frame.current?.contentWindow;
      const [next] = event.ports;
      if (
        !source ||
        !next ||
        source === served ||
        event.source !== source ||
        event.data?.type !== INLINE_ASSET_READY ||
        event.data.token !== token
      )
        return;
      served = source;
      port?.close();
      port = next;
      for (const log of sent.values()) for (const message of log) port.postMessage(message);
    };
    window.addEventListener("message", ready);
    return () => {
      window.removeEventListener("message", ready);
      controller.abort();
      port?.close();
      setAssetError(null);
    };
  }, [state, frame, pluginId]);

  useEffect(() => {
    if (state.status !== "ready" || state.kind !== "html" || !state.token) return;
    const token = state.token;
    const receive = (event: MessageEvent) => onMessage(event);
    window.addEventListener("message", receive);
    if (!state.fragment) return () => window.removeEventListener("message", receive);
    // Theme switches restyle the host without remounting the frame.
    const root = document.documentElement;
    let theme = readHostTheme(root);
    let pending = 0;
    const syncTheme = () => {
      pending = 0;
      const next = readHostTheme(root);
      if (sameTheme(theme, next)) return;
      theme = next;
      frame.current?.contentWindow?.postMessage(
        { type: FRAGMENT_MESSAGES.theme, token, theme },
        "*",
      );
    };
    // bb swaps theme classes on <html> and may rewrite a theme <style> in
    // place, so watch both. Coalesce bursts into one style read per frame.
    const observer = new MutationObserver(() => {
      pending ||= requestAnimationFrame(syncTheme);
    });
    observer.observe(root, { attributes: true });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      window.removeEventListener("message", receive);
      observer.disconnect();
      cancelAnimationFrame(pending);
    };
  }, [state, frame]);

  return { contentHeight, tweaks, frameKey, assetError };
}

function PreviewActions({
  hasTweaks,
  canShareState,
  tweakOpen,
  saving,
  onTweak,
  onShare,
}: {
  hasTweaks: boolean;
  canShareState: boolean;
  tweakOpen: boolean;
  saving: boolean;
  onTweak: () => void;
  onShare: () => void;
}) {
  return (
    <>
      {hasTweaks && (
        <button type="button" aria-expanded={tweakOpen} onClick={onTweak}>
          Tweak
        </button>
      )}
      {canShareState && (
        <button type="button" disabled={saving} onClick={onShare}>
          Use saved state
        </button>
      )}
    </>
  );
}

function WidgetStateNotice({
  source,
  readError,
  saveError,
  onRetry,
}: {
  source: string;
  readError: string | null;
  saveError: string | null;
  onRetry: () => void;
}) {
  if (readError)
    return (
      <Alert source={readError} error>
        Saved state is unavailable. Preview changes will not be saved until you retry.
        <button type="button" onClick={onRetry}>
          Retry saved state
        </button>
      </Alert>
    );
  if (saveError)
    return (
      <Alert source={source} error>
        Could not save visualization state: {saveError}. Try adding it to chat again.
      </Alert>
    );
  return null;
}

function ExpandedPreview({
  attributes,
  source,
  message,
  onToggle,
}: PluginMessageDirectiveProps & { onToggle: () => void }) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const file = attributes.file?.trim() ?? "";
  const previewHeight = parsePreviewHeight(attributes.height);
  const fixedHeight = Boolean(attributes.height?.trim());
  // Only content-sized fragments are remembered, so a hit implies one.
  const [rememberedHeight, rememberHeight] = useRememberedHeight(
    `${pluginId}.inline-vis.heights`,
    `${message.threadId}:${message.id}:${file}`,
  );
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const frame = useRef<HTMLIFrameElement>(null);
  const surface = useRef<HTMLDialogElement>(null);
  const wideTrigger = useRef<HTMLButtonElement>(null);
  const [wide, setWide] = useState(false);
  const [tweakOpen, setTweakOpen] = useState(false);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const leaveWide = useCallback(() => {
    if (!wide) return;
    setWide(false);
    wideTrigger.current?.focus();
  }, [wide]);
  const {
    hasSavedState,
    saving,
    saveError,
    readError,
    restore,
    addContext: attachContext,
    updateState,
    updateTweaks,
  } = useWidgetState({ threadId: message.threadId, messageId: message.id, file }, pluginId);
  const addContext = useCallback(
    (prompt?: string) =>
      attachContext(prompt, () => {
        // Native modal close restores its old focus. Close before composer focus.
        if (surface.current?.getAttribute("aria-modal") === "true") {
          surface.current.close();
          setWide(false);
        }
      }),
    [attachContext],
  );
  const sendToFrame = (type: string, payload: Record<string, unknown>) => {
    if (state.status === "ready" && state.kind === "html" && state.token)
      frame.current?.contentWindow?.postMessage({ type, token: state.token, ...payload }, "*");
  };
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    if (element.open) element.close();
    if (wide) element.showModal();
    // An inline preview must not take focus from the composer on load.
    else element.setAttribute("open", "");
  }, [wide, state.status]);
  const { contentHeight, tweaks, frameKey, assetError } = useFragmentBridge(
    state,
    frame,
    updateState,
    updateTweaks,
    addContext,
    leaveWide,
  );
  useEffect(() => {
    // Wide view lays the fragment out at another width.
    if (contentHeight !== null && !fixedHeight && !wide)
      rememberHeight(fragmentHeight(contentHeight));
  }, [contentHeight, fixedHeight, wide, rememberHeight]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const result = await loadPreview(sdk, message.threadId, file, controller.signal);
        if (result.kind === "markdown") {
          if (!cancelled)
            setState({
              status: "ready",
              kind: "markdown",
              file: result.file,
              hostId: result.hostId,
              url: result.url,
              content: previewMarkdown(result.content, result.url),
            });
          return;
        }
        const fragment = isFragment(result.html);
        const [widget, videoPlayer] = await Promise.all([
          fragment ? restore(controller.signal) : null,
          fragment && mayNeedVideoPlayer(result.html) ? loadVideoPlayer(pluginId) : undefined,
        ]);
        if (cancelled) return;
        const sizes = videoSizeStore(pluginId);
        const prepared = prepareInlineAssets(
          result.html,
          result.url,
          fragment
            ? (document, token) => {
                if (videoPlayer) upgradeVideoPlayers(document, videoPlayer);
                injectFragmentRuntime(document, {
                  token,
                  theme: readHostTheme(window.document.documentElement),
                  state: widget?.state === "null" ? null : (widget?.state ?? null),
                  tweaks: widget?.tweaks ?? null,
                });
              }
            : undefined,
          (path) => sizes.read(videoSizeKey(result, path)),
        );
        if (!cancelled)
          setState({
            status: "ready",
            kind: "html",
            file: result.file,
            hostId: result.hostId,
            url: result.url,
            fragment,
            ...prepared,
          });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file, message.threadId, sdk, restore, restoreRevision, pluginId]);

  if (state.status === "error") {
    return (
      <>
        <PreviewHeader file={file} expanded onToggle={onToggle} onOpen={null} />
        <Alert source={source} error>
          Failed to load {file}: {state.message}
          <button type="button" onClick={() => setRestoreRevision((value) => value + 1)}>
            Retry preview
          </button>
        </Alert>
      </>
    );
  }

  if (state.status === "loading") {
    return (
      <>
        <PreviewHeader file={file} expanded onToggle={onToggle} onOpen={null} />
        <output
          aria-busy="true"
          aria-label={`Loading visualization ${file}`}
          style={{
            height: (fixedHeight ? previewHeight : rememberedHeight) ?? DEFAULT_HEIGHT_PX,
          }}
          className="block w-full p-3"
        >
          <Skeleton className="size-full" />
        </output>
      </>
    );
  }

  const hasTweaks = state.kind === "html" && state.fragment && tweaks.groups.length > 0;
  const canShareState = state.kind === "html" && state.fragment && hasSavedState;
  const height =
    state.kind !== "html" || !state.fragment || fixedHeight
      ? (previewHeight ?? DEFAULT_HEIGHT_PX)
      : contentHeight !== null
        ? fragmentHeight(contentHeight)
        : (rememberedHeight ?? DEFAULT_HEIGHT_PX);
  const actions = (
    <PreviewActions
      hasTweaks={hasTweaks}
      canShareState={canShareState}
      tweakOpen={tweakOpen}
      saving={saving}
      onTweak={() => setTweakOpen(!tweakOpen)}
      onShare={() => void addContext()}
    />
  );
  return (
    <>
      <PreviewHeader
        file={state.file}
        expanded
        onToggle={onToggle}
        onOpen={() =>
          navigate.experimental_openFilePreview({
            target: { kind: "host", hostId: state.hostId, path: state.file },
            location: null,
          })
        }
        onWide={() => setWide(true)}
        wideTrigger={wideTrigger}
      />
      {/* Plain previews, such as recordings, sit flush under the header. */}
      {(hasTweaks || canShareState) && <div className="inline-vis-toolbar">{actions}</div>}
      <dialog
        ref={surface}
        className={`inline-vis-surface${wide ? " inline-vis-wide" : ""}`}
        role={wide ? "dialog" : "region"}
        aria-label={wide ? `Wide visualization: ${state.file}` : `Visualization: ${state.file}`}
        aria-modal={wide || undefined}
        onCancel={(event) => {
          event.preventDefault();
          leaveWide();
        }}
      >
        {wide && (
          <div className="inline-vis-wide-header">
            <span>{state.file.split(/[\\/]/u).pop()}</span>
            <div>
              {actions}
              <button
                type="button"
                onClick={() => {
                  leaveWide();
                }}
              >
                Back to chat
              </button>
            </div>
          </div>
        )}
        <WidgetStateNotice
          source={source}
          readError={readError}
          saveError={saveError}
          onRetry={() => setRestoreRevision((value) => value + 1)}
        />
        {assetError && (
          <Alert source={source} error>
            Some media in {state.file} did not load: {assetError}
          </Alert>
        )}
        <div
          className={`inline-vis-workspace${tweakOpen && tweaks.groups.length > 0 ? " inline-vis-with-tweaks" : ""}`}
        >
          <div className="inline-vis-preview">
            <PreviewDocument preview={state} frame={frame} frameKey={frameKey} height={height} />
          </div>
          {tweakOpen && tweaks.groups.length > 0 && (
            <TweakPanel
              groups={tweaks.groups}
              original={tweaks.original}
              saving={saving}
              readOnly={readError !== null}
              onClose={() => setTweakOpen(false)}
              onChange={(groupId, controlId, value) =>
                sendToFrame(FRAGMENT_MESSAGES.tweakChange, { groupId, controlId, value })
              }
              onReset={(groupId) => sendToFrame(FRAGMENT_MESSAGES.tweakReset, { groupId })}
              onOriginal={(active) => sendToFrame(FRAGMENT_MESSAGES.tweakOriginal, { active })}
              onApply={() => void addContext("Use these design adjustments for the next revision.")}
            />
          )}
        </div>
      </dialog>
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: "inline-vis", component: InlineVisDirective });
});
