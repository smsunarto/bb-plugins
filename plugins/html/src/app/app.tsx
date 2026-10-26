import {
  definePluginApp,
  experimental_ImageLightbox as ImageLightbox,
  experimental_usePluginId,
  useBbNavigate,
  type PluginMessageDirectiveMessage,
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

import { Skeleton } from "./components/ui/skeleton.tsx";
import "./app.css";
import { prepareFrameDocument } from "./frame-document.ts";
import {
  FRAGMENT_MESSAGES,
  injectFragmentRuntime,
  isFragment,
  parseFrameMessage,
} from "../shared/fragment-runtime.ts";
import {
  HTML_RENDER_DIRECTIVE,
  HTML_RENDER_MAX_FIT_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  htmlRenderPagePath,
  htmlRenderResult,
  htmlRenderThemeMessage,
  injectHtmlRenderBootstrap,
  readHtmlRenderContentHeight,
  readHtmlRenderDirective,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
} from "../shared/html-render.ts";
import {
  PREVIEW_FRAME_MESSAGES,
  PREVIEW_FRAME_SANDBOX,
  previewFrameUrl,
} from "../shared/preview-frame.ts";
import { createPreviewExpansion } from "./preview-expansion.ts";
import { useRememberedHeight } from "./preview-sizes.ts";
import { loadVideoPlayer, mayNeedVideoPlayer, upgradeVideoPlayers } from "./video-player.ts";
import { TweakPanel } from "./tweak-panel.tsx";
import type { TweakGroup } from "../shared/tweak-contract.ts";
import { observeBbTheme, readBbTheme } from "./theme.ts";
import { useWidgetState } from "./use-widget-state.ts";
import { PreviewActions, PreviewHeader, PreviewSurface } from "./components/preview-surface.tsx";

/** A page `html_render` published. `key` identifies it within its message, for remembered heights. */
type PreviewTarget = { label: string; key: string; id: string; height: number };

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      label: string;
      html: string;
      token: string;
      /** A bare fragment runs in the visualization runtime; a full document gets the page bootstrap. */
      fragment: boolean;
    }
  | { status: "error"; message: string };

type ReadyState = Extract<LoadState, { status: "ready" }>;

// A frame even a few pixels shorter than its page takes the reader's scroll.
// `html_render` rejects viewport units, so a page cannot grow with its frame.
const pageHeight = (contentHeight: number) =>
  Math.min(HTML_RENDER_MAX_FIT_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.ceil(contentHeight)));

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
      className={`html-page-alert${error ? " html-page-alert-error" : ""}`}
      title={source}
    >
      {children}
    </div>
  );
}

/** A page `html_render` published, loaded from the bb server by its id. */
function HtmlRenderDirective({ attributes, source, message }: PluginMessageDirectiveProps) {
  const reference = readHtmlRenderDirective(attributes);
  if (!reference)
    return (
      <Alert source={source}>
        html-render needs the id <code>html_render</code> returned. Render the page again.
      </Alert>
    );
  return (
    <CollapsiblePreview
      key={`${message.threadId}:${message.id}:${reference.id}`}
      target={{
        label: reference.title,
        key: `page:${reference.id}`,
        id: reference.id,
        height: reference.height,
      }}
      source={source}
      message={message}
    />
  );
}

type PreviewProps = {
  target: PreviewTarget;
  /** The directive text, shown as the alert tooltip. */
  source: string;
  message: PluginMessageDirectiveMessage;
};

function CollapsiblePreview(props: PreviewProps) {
  const pluginId = experimental_usePluginId();
  const [expansion] = useState(() => createPreviewExpansion(`${pluginId}.collapsed`));
  const card = useRef<HTMLElement>(null);
  const expanded = useSyncExternalStore(expansion.subscribe, expansion.getSnapshot, () => false);
  useLayoutEffect(
    () => expansion.register(props.message.threadId, card.current!),
    [expansion, props.message.threadId],
  );
  return (
    <figure ref={card} className="html-page-card">
      {expanded ? (
        <ExpandedPreview {...props} onToggle={expansion.toggle} />
      ) : (
        <PreviewHeader label={props.target.label} expanded={false} onToggle={expansion.toggle} />
      )}
    </figure>
  );
}

function PreviewFrame({
  label,
  frame,
  frameKey,
  height,
}: {
  label: string;
  frame: RefObject<HTMLIFrameElement | null>;
  frameKey: number;
  height: number;
}) {
  const pluginId = experimental_usePluginId();
  return (
    <iframe
      key={frameKey}
      title={`HTML: ${label}`}
      src={previewFrameUrl(pluginId)}
      ref={frame}
      sandbox={PREVIEW_FRAME_SANDBOX}
      // The opaque frame needs this for a video player's fullscreen button.
      allow="fullscreen"
      style={{ height }}
      className="html-page-frame"
    />
  );
}

/** Links and images a frame asks the host to open, from a click in that frame. */
function readHostRequest(event: MessageEvent, frame: HTMLIFrameElement | null) {
  const link = readHtmlRenderLinkRequest(event.data);
  const image = link ? undefined : readHtmlRenderImageRequest(event.data);
  if (!link && !image) return null;
  // A page script can post without a click, so the frame must hold focus and activation.
  const clicked = document.activeElement === frame && navigator.userActivation?.isActive !== false;
  return clicked ? { link, image } : null;
}

/**
 * What a fragment's link bridge or a published document posts. Returns true
 * when the message was one of these, so the token protocol need not parse it.
 */
function receivePageMessage(
  event: MessageEvent,
  state: ReadyState,
  frame: HTMLIFrameElement,
  actions: {
    openUrl: (url: string) => void;
    openImage: (image: { src: string; name: string }) => void;
    setContentHeight: (height: number) => void;
  },
): boolean {
  const request = readHostRequest(event, frame);
  if (request?.link) {
    actions.openUrl(request.link.url);
    frame.contentWindow?.postMessage(htmlRenderResult(request.link.id), "*");
    return true;
  }
  if (request?.image) {
    actions.openImage(request.image);
    return true;
  }
  // A document reports its size; the fragment runtime uses the token protocol.
  if (state.fragment) return false;
  const height = readHtmlRenderContentHeight(event.data);
  if (height === undefined) return false;
  actions.setContentHeight(height);
  return true;
}

function useFragmentBridge(
  state: LoadState,
  frame: RefObject<HTMLIFrameElement | null>,
  updateState: (state: string, modelContent: string | null) => void,
  updateTweaks: (groups: TweakGroup[], changed: boolean, reset?: string | null) => void,
  addContext: (prompt?: string) => Promise<void>,
  leaveWide: () => void,
  openImage: (image: { src: string; name: string }) => void,
) {
  const navigate = useBbNavigate();
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
    const element = frame.current;
    if (!element?.contentWindow || event.source !== element.contentWindow) return;
    if (state.status !== "ready") return;
    const actions = { openUrl: navigate.openUrl, openImage, setContentHeight };
    if (receivePageMessage(event, state, element, actions)) return;
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
    if (state.status !== "ready") return;
    const { html } = state;
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
  useEffect(() => {
    if (state.status !== "ready") return;
    const { token, fragment } = state;
    const receive = (event: MessageEvent) => onMessage(event);
    window.addEventListener("message", receive);
    // Theme switches restyle the frame without remounting it.
    const stop = observeBbTheme((theme) =>
      frame.current?.contentWindow?.postMessage(
        fragment ? { type: FRAGMENT_MESSAGES.theme, token, theme } : htmlRenderThemeMessage(theme),
        "*",
      ),
    );
    return () => {
      window.removeEventListener("message", receive);
      stop();
    };
  }, [state, frame]);

  return { contentHeight, tweaks, frameKey };
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

export function pageUrl(pluginId: string, id: string): string {
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http${htmlRenderPagePath(id)}`;
}

/** A published page never changes, so the browser cache can answer while offline. */
async function loadPage(pluginId: string, id: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(pageUrl(pluginId, id), { credentials: "same-origin", signal });
  if (response.status === 404)
    throw new Error("the page is no longer stored. Ask the agent to render it again.");
  if (!response.ok) throw new Error(`the page could not be loaded: HTTP ${response.status}`);
  return response.text();
}

/**
 * Load a published page and prepare its frame document. A fragment restores
 * its saved state and gains the runtime; a document gets the page bootstrap.
 */
async function preparePage(
  { id, label }: { id: string; label: string },
  {
    pluginId,
    restore,
    signal,
  }: {
    pluginId: string;
    restore: ReturnType<typeof useWidgetState>["restore"];
    signal: AbortSignal;
  },
): Promise<ReadyState> {
  const html = await loadPage(pluginId, id, signal);
  const fragment = isFragment(html);
  if (!fragment) {
    return {
      status: "ready",
      label,
      fragment,
      ...prepareFrameDocument(injectHtmlRenderBootstrap(html, readBbTheme())),
    };
  }
  const [widget, videoPlayer] = await Promise.all([
    restore(signal),
    mayNeedVideoPlayer(html) ? loadVideoPlayer(pluginId) : undefined,
  ]);
  signal.throwIfAborted();
  return {
    status: "ready",
    label,
    fragment,
    ...prepareFrameDocument(html, (document, token) => {
      if (videoPlayer) upgradeVideoPlayers(document, videoPlayer);
      injectFragmentRuntime(document, {
        token,
        theme: readBbTheme(),
        state: widget?.state === "null" ? null : (widget?.state ?? null),
        tweaks: widget?.tweaks ?? null,
      });
    }),
  };
}

function ExpandedPreview({
  target,
  source,
  message,
  onToggle,
}: PreviewProps & { onToggle: () => void }) {
  const pluginId = experimental_usePluginId();
  const { label, id } = target;
  const [rememberedHeight, rememberHeight] = useRememberedHeight(
    `${pluginId}.heights`,
    `${message.threadId}:${message.id}:${target.key}`,
  );
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const frame = useRef<HTMLIFrameElement>(null);
  const surface = useRef<HTMLDialogElement>(null);
  const wideTrigger = useRef<HTMLButtonElement>(null);
  const [wide, setWide] = useState(false);
  const [tweakOpen, setTweakOpen] = useState(false);
  const [image, setImage] = useState<{ src: string; name: string } | null>(null);
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
  } = useWidgetState(
    { threadId: message.threadId, messageId: message.id, pageId: id },
    pluginId,
    label,
  );
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
    if (state.status === "ready")
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
  const { contentHeight, tweaks, frameKey } = useFragmentBridge(
    state,
    frame,
    updateState,
    updateTweaks,
    addContext,
    leaveWide,
    setImage,
  );
  useEffect(() => {
    // Wide view lays the page out at another width.
    if (contentHeight !== null && !wide) rememberHeight(pageHeight(contentHeight));
  }, [contentHeight, wide, rememberHeight]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const ready = await preparePage(
          { id, label },
          { pluginId, restore, signal: controller.signal },
        );
        if (!cancelled) setState(ready);
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
  }, [id, label, restore, restoreRevision, pluginId]);

  if (state.status === "error") {
    return (
      <>
        <PreviewHeader label={label} expanded onToggle={onToggle} />
        <Alert source={source} error>
          Failed to load {label}: {state.message}
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
        <PreviewHeader label={label} expanded onToggle={onToggle} />
        <output
          aria-busy="true"
          aria-label={`Loading visualization ${label}`}
          style={{ height: rememberedHeight ?? target.height }}
          className="block w-full p-3"
        >
          <Skeleton className="size-full" />
        </output>
      </>
    );
  }

  const hasTweaks = state.fragment && tweaks.groups.length > 0;
  const canShareState = state.fragment && hasSavedState;
  // Until the page reports its size, the height its author measured holds the space.
  const height =
    contentHeight !== null ? pageHeight(contentHeight) : (rememberedHeight ?? target.height);
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
        label={state.label}
        expanded
        onToggle={onToggle}
        onWide={() => setWide(true)}
        wideTrigger={wideTrigger}
      />
      {/* Plain previews, such as recordings, sit flush under the header. */}
      {(hasTweaks || canShareState) && <div className="html-page-toolbar">{actions}</div>}
      <PreviewSurface
        dialogRef={surface}
        wide={wide}
        label={state.label}
        onLeaveWide={leaveWide}
        actions={actions}
        notice={
          <WidgetStateNotice
            source={source}
            readError={readError}
            saveError={saveError}
            onRetry={() => setRestoreRevision((value) => value + 1)}
          />
        }
        preview={
          <PreviewFrame label={state.label} frame={frame} frameKey={frameKey} height={height} />
        }
        showPanel={tweakOpen && tweaks.groups.length > 0}
        panel={
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
        }
      />
      {image ? (
        <ImageLightbox
          isOpen
          imageSrc={image.src}
          imageAlt={image.name}
          title={image.name}
          onClose={() => setImage(null)}
        />
      ) : null}
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: HTML_RENDER_DIRECTIVE, component: HtmlRenderDirective });
});
