import {
  definePluginApp,
  experimental_ImageLightbox as ImageLightbox,
  experimental_usePluginId,
  Markdown,
  useBbNavigate,
  useSdk,
  type ExperimentalCodeFenceRendererProps,
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
import {
  fetchInlineAsset,
  INLINE_ASSET_READY,
  type InlineAssetMessage,
  prepareInlineAssets,
  prepareInlineDocument,
  type InlinePreviewAsset,
} from "./inline-assets.ts";
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
import { pageStateKey } from "../shared/state-contract.ts";
import { previewMarkdown } from "./preview-markdown.ts";
import {
  PREVIEW_FRAME_MESSAGES,
  PREVIEW_FRAME_SANDBOX,
  previewFrameUrl,
} from "../shared/preview-frame.ts";
import { createPreviewExpansion } from "./inline-vis-expansion.ts";
import { loadPreview } from "./load-preview.ts";
import { useRememberedHeight, videoSizes } from "./preview-sizes.ts";
import { loadVideoPlayer, mayNeedVideoPlayer, upgradeVideoPlayers } from "./video-player.ts";
import { TweakPanel } from "./tweak-panel.tsx";
import type { TweakGroup } from "../shared/tweak-contract.ts";
import { observeBbTheme, readBbTheme } from "./theme.ts";
import { useWidgetState } from "./use-widget-state.ts";
import {
  PreviewActions,
  PreviewHeader,
  PreviewSurface,
  type SourceToggle,
} from "./components/preview-surface.tsx";

/**
 * The fenced-block language this plugin renders. bb's built-in plugin claims
 * `inline-vis`, and bb renders neither when two plugins claim one language.
 */
export const FENCE_LANGUAGE = "scott-inline-vis";

/**
 * What a card shows: a file on the thread host, HTML written in the reply, or
 * a page `html_render` published. `key` identifies it within its message, for
 * remembered heights.
 */
type PreviewTarget = { label: string; key: string } & (
  | { kind: "file"; file: string; height: string | undefined }
  | { kind: "fence"; code: string }
  | { kind: "page"; id: string; height: number }
);

/** The host file behind a ready preview. HTML written in the reply has none. */
type PreviewLocation = { file: string; hostId: string; url: string };

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      kind: "html";
      label: string;
      location: PreviewLocation | null;
      html?: string;
      assets: InlinePreviewAsset[];
      token?: string;
      fragment: boolean;
      /** Published by `html_render`: no viewport units, so it fits its content. */
      page: boolean;
    }
  | {
      status: "ready";
      kind: "markdown";
      label: string;
      location: PreviewLocation;
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
// A frame even a few pixels shorter than its page takes the reader's scroll.
// `html_render` rejects viewport units, so a page cannot grow with its frame.
const pageHeight = (contentHeight: number) =>
  Math.min(HTML_RENDER_MAX_FIT_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.ceil(contentHeight)));

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

function InlineVisDirective({ attributes, source, message }: PluginMessageDirectiveProps) {
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
      target={{ kind: "file", label: file, key: file, file, height: attributes.height }}
      source={source}
      message={message}
    />
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
        kind: "page",
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

/**
 * HTML written in the reply as a fenced block. bb keeps this instance for the
 * whole stream, so the card registers once and loads when the fence closes.
 */
function InlineVisFence({
  code,
  language,
  status,
  index,
  message,
  Original,
}: ExperimentalCodeFenceRendererProps) {
  const [sourceShown, setSourceShown] = useState(false);
  // An interrupted reply or an empty block stays bb's ordinary code block.
  if (status === "unclosed" || (status === "closed" && !code.trim())) return <Original />;
  const label = `HTML block ${index + 1}`;
  return (
    <>
      <CollapsiblePreview
        target={{ kind: "fence", label, key: `#${language}#${index}`, code }}
        source={label}
        message={message}
        writing={status === "streaming"}
        sourceToggle={{ shown: sourceShown, onToggle: () => setSourceShown(!sourceShown) }}
      />
      {sourceShown && <Original />}
    </>
  );
}

type PreviewProps = {
  target: PreviewTarget;
  /** Shown as the alert tooltip: the directive text, or the block's label. */
  source: string;
  message: PluginMessageDirectiveMessage;
  sourceToggle?: SourceToggle;
};

function CollapsiblePreview({ writing = false, ...props }: PreviewProps & { writing?: boolean }) {
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
      {expanded && !writing ? (
        <ExpandedPreview {...props} onToggle={expansion.toggle} />
      ) : (
        <>
          <PreviewHeader
            label={props.target.label}
            expanded={expanded}
            onToggle={expansion.toggle}
            onOpen={null}
            sourceToggle={props.sourceToggle}
          />
          {expanded && (
            <output className="inline-vis-pending" aria-busy="true">
              Writing visualization…
            </output>
          )}
        </>
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
      title={`inline-vis: ${preview.label}`}
      // Only a prepared document lacks HTML, and only a host file skips preparation.
      src={
        preview.html === undefined && preview.location
          ? preview.location.url
          : previewFrameUrl(pluginId)
      }
      ref={frame}
      sandbox={PREVIEW_FRAME_SANDBOX}
      // The opaque frame needs this for a video player's fullscreen button.
      allow="fullscreen"
      style={{ height }}
      className="inline-vis-frame"
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

type ReadyHtml = Extract<LoadState, { status: "ready"; kind: "html" }>;

/**
 * What a fragment's link bridge or a published document posts. Returns true
 * when the message was one of these, so the token protocol need not parse it.
 */
function receivePageMessage(
  event: MessageEvent,
  state: ReadyHtml,
  frame: HTMLIFrameElement,
  actions: {
    openUrl: (url: string) => void;
    openImage: (image: { src: string; name: string }) => void;
    setContentHeight: (height: number) => void;
  },
): boolean {
  if (!state.fragment && !state.page) return false;
  const request = readHostRequest(event, frame);
  if (request?.link) {
    actions.openUrl(request.link.url);
    frame.contentWindow?.postMessage(htmlRenderResult(request.link.id), "*");
    return true;
  }
  if (request?.image && state.page) {
    actions.openImage(request.image);
    return true;
  }
  // A published document reports its size; the fragment runtime uses the token protocol.
  if (!state.page || state.fragment) return false;
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
  const pluginId = experimental_usePluginId();
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
    if (state.status !== "ready" || state.kind !== "html" || !state.token) return;
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
      !state.location ||
      state.assets.length === 0
    )
      return;
    const { token, location } = state;
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
        if ("size" in message) sizes.write(videoSizeKey(location, asset.path), message.size);
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
    const { token, fragment, page } = state;
    const receive = (event: MessageEvent) => onMessage(event);
    window.addEventListener("message", receive);
    if (!fragment && !page) return () => window.removeEventListener("message", receive);
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

  return { contentHeight, tweaks, frameKey, assetError };
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

type ReadyState = Extract<LoadState, { status: "ready" }>;

/** Opens a preview's host file in bb's viewer. HTML written in the reply has none. */
function hostFileOpener(
  navigate: ReturnType<typeof useBbNavigate>,
  location: PreviewLocation | null,
): (() => void) | null {
  if (!location) return null;
  return () =>
    navigate.experimental_openFilePreview({
      target: { kind: "host", hostId: location.hostId, path: location.file },
      location: null,
    });
}

/** The parts of a target the loader and sizing read. */
function targetSource(target: PreviewTarget) {
  if (target.kind === "file")
    return { file: target.file, code: null, page: null, requestedHeight: target.height };
  if (target.kind === "page")
    return { file: null, code: null, page: target.id, requestedHeight: undefined };
  return { file: null, code: target.code, page: null, requestedHeight: undefined };
}

/** Saved state follows a host file or a published page; a fenced block keeps it in memory. */
function stateKey(target: PreviewTarget): string | null {
  if (target.kind === "file") return target.file;
  if (target.kind === "page") return pageStateKey(target.id);
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
 * Read a host file, or take a fenced block's HTML, and prepare its frame
 * document. Fragments restore saved state and gain the runtime first.
 */
async function prepareTarget(
  {
    file,
    code,
    page,
    label,
  }: { file: string | null; code: string | null; page: string | null; label: string },
  {
    sdk,
    threadId,
    pluginId,
    restore,
    signal,
  }: {
    sdk: ReturnType<typeof useSdk>;
    threadId: string;
    pluginId: string;
    restore: ReturnType<typeof useWidgetState>["restore"];
    signal: AbortSignal;
  },
): Promise<ReadyState> {
  const result = file === null ? null : await loadPreview(sdk, threadId, file, signal);
  const pageHtml = page === null ? null : await loadPage(pluginId, page, signal);
  if (result?.kind === "markdown")
    return {
      status: "ready",
      kind: "markdown",
      label: result.file,
      location: { file: result.file, hostId: result.hostId, url: result.url },
      content: previewMarkdown(result.content, result.url),
    };
  const html = result ? result.html : (pageHtml ?? code ?? "");
  const fragment = isFragment(html);
  const published = pageHtml !== null;
  const [widget, videoPlayer] = await Promise.all([
    fragment ? restore(signal) : null,
    fragment && mayNeedVideoPlayer(html) ? loadVideoPlayer(pluginId) : undefined,
  ]);
  signal.throwIfAborted();
  const prepare = fragment
    ? (document: Document, token: string) => {
        if (videoPlayer) upgradeVideoPlayers(document, videoPlayer);
        injectFragmentRuntime(document, {
          token,
          theme: readBbTheme(),
          state: widget?.state === "null" ? null : (widget?.state ?? null),
          tweaks: widget?.tweaks ?? null,
        });
      }
    : undefined;
  if (!result)
    return {
      status: "ready",
      kind: "html",
      label,
      location: null,
      fragment,
      page: published,
      // A published document gets the page theme, fit-to-content height, and host links.
      ...prepareInlineDocument(
        published && !fragment ? injectHtmlRenderBootstrap(html, readBbTheme()) : html,
        prepare,
      ),
    };
  const sizes = videoSizeStore(pluginId);
  return {
    status: "ready",
    kind: "html",
    label: result.file,
    location: { file: result.file, hostId: result.hostId, url: result.url },
    fragment,
    page: false,
    ...prepareInlineAssets(html, result.url, prepare, (path) =>
      sizes.read(videoSizeKey(result, path)),
    ),
  };
}

/**
 * Fragments and published pages fit their content; other documents and
 * Markdown keep a fixed viewport. Until a page reports its size, the height
 * its author measured holds the space.
 */
function frameHeight(
  state: ReadyState,
  target: PreviewTarget,
  heights: { fixed: number | null; content: number | null; remembered: number | undefined },
): number {
  if (heights.fixed !== null) return heights.fixed;
  if (state.kind !== "html" || (!state.fragment && !state.page)) return DEFAULT_HEIGHT_PX;
  if (heights.content !== null)
    return state.page ? pageHeight(heights.content) : fragmentHeight(heights.content);
  return heights.remembered ?? (target.kind === "page" ? target.height : DEFAULT_HEIGHT_PX);
}

function ExpandedPreview({
  target,
  source,
  message,
  sourceToggle,
  onToggle,
}: PreviewProps & { onToggle: () => void }) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const { label } = target;
  const { file, code, page, requestedHeight } = targetSource(target);
  const key = stateKey(target);
  const previewHeight = parsePreviewHeight(requestedHeight);
  const fixedHeight = Boolean(requestedHeight?.trim());
  // Only content-sized fragments are remembered, so a hit implies one.
  const [rememberedHeight, rememberHeight] = useRememberedHeight(
    `${pluginId}.inline-vis.heights`,
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
    key === null ? null : { threadId: message.threadId, messageId: message.id, file: key },
    pluginId,
    target.kind === "file" ? label.split(/[\\/]/u).pop() || label : label,
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
    setImage,
  );
  const published = state.status === "ready" && state.kind === "html" && state.page;
  const fitHeight = published ? pageHeight : fragmentHeight;
  useEffect(() => {
    // Wide view lays the fragment out at another width.
    if (contentHeight !== null && !fixedHeight && !wide) rememberHeight(fitHeight(contentHeight));
  }, [contentHeight, fixedHeight, wide, rememberHeight, fitHeight]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const ready = await prepareTarget(
          { file, code, page, label },
          { sdk, threadId: message.threadId, pluginId, restore, signal: controller.signal },
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
  }, [file, code, page, label, message.threadId, sdk, restore, restoreRevision, pluginId]);

  if (state.status === "error") {
    return (
      <>
        <PreviewHeader
          label={label}
          expanded
          onToggle={onToggle}
          onOpen={null}
          sourceToggle={sourceToggle}
        />
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
        <PreviewHeader
          label={label}
          expanded
          onToggle={onToggle}
          onOpen={null}
          sourceToggle={sourceToggle}
        />
        <output
          aria-busy="true"
          aria-label={`Loading visualization ${label}`}
          style={{
            height:
              (fixedHeight ? previewHeight : rememberedHeight) ??
              (target.kind === "page" ? target.height : DEFAULT_HEIGHT_PX),
          }}
          className="block w-full p-3"
        >
          <Skeleton className="size-full" />
        </output>
      </>
    );
  }

  const hostFile = state.location;
  const hasTweaks = state.kind === "html" && state.fragment && tweaks.groups.length > 0;
  const canShareState = state.kind === "html" && state.fragment && hasSavedState;
  const height = frameHeight(state, target, {
    fixed: fixedHeight ? previewHeight : null,
    content: contentHeight,
    remembered: rememberedHeight,
  });
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
        onOpen={hostFileOpener(navigate, hostFile)}
        onWide={() => setWide(true)}
        wideTrigger={wideTrigger}
        sourceToggle={sourceToggle}
      />
      {/* Plain previews, such as recordings, sit flush under the header. */}
      {(hasTweaks || canShareState) && <div className="inline-vis-toolbar">{actions}</div>}
      <PreviewSurface
        dialogRef={surface}
        wide={wide}
        label={state.label}
        wideLabel={hostFile?.file.split(/[\\/]/u).pop() ?? state.label}
        onLeaveWide={leaveWide}
        actions={actions}
        notice={
          <>
            <WidgetStateNotice
              source={source}
              readError={readError}
              saveError={saveError}
              onRetry={() => setRestoreRevision((value) => value + 1)}
            />
            {assetError && (
              <Alert source={source} error>
                Some media in {state.label} did not load: {assetError}
              </Alert>
            )}
          </>
        }
        preview={
          <PreviewDocument preview={state} frame={frame} frameKey={frameKey} height={height} />
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
            // Adjustments travel in a saved-state pill, which a fenced block cannot keep.
            onApply={
              key !== null
                ? () => void addContext("Use these design adjustments for the next revision.")
                : undefined
            }
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
  app.slots.messageDirective({ id: "inline-vis", component: InlineVisDirective });
  app.slots.experimental_codeFenceRenderer({
    id: "inline-vis",
    languages: [FENCE_LANGUAGE],
    component: InlineVisFence,
  });
});
