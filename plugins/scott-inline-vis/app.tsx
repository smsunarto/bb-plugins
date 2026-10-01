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
  INLINE_ASSET_MESSAGE,
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
import { createPreviewExpansion } from "./inline-vis-expansion.ts";
import { loadPreview } from "./load-preview.ts";
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
      srcDoc?: string;
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
}: {
  file: string;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (() => void) | null;
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
        <svg
          aria-hidden="true"
          className="inline-vis-chevron"
          viewBox="0 0 10 16"
          fill="currentColor"
        >
          <path d="M.47 5.47a.75.75 0 0 1 1.06 0L5 8.94l3.47-3.47a.75.75 0 0 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06" />
        </svg>
      </button>
      {onOpen === null ? (
        <span aria-hidden="true" className="inline-vis-action" />
      ) : (
        <button
          type="button"
          className="inline-vis-action inline-vis-open"
          aria-label={`Open ${file} in sidebar`}
          title="Open in sidebar"
          onClick={onOpen}
        >
          <svg
            aria-hidden="true"
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
  height,
}: {
  preview: Extract<LoadState, { status: "ready" }>;
  frame: RefObject<HTMLIFrameElement | null>;
  height: number;
}) {
  if (preview.kind === "markdown")
    return (
      <div style={{ height }} className="inline-vis-markdown">
        <Markdown content={preview.content} />
      </div>
    );
  return (
    <iframe
      title={`inline-vis: ${preview.file}`}
      src={preview.srcDoc ? undefined : preview.url}
      srcDoc={preview.srcDoc}
      ref={frame}
      sandbox="allow-scripts"
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
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [tweaks, setTweaks] = useState<{ groups: TweakGroup[]; original: boolean }>({
    groups: [],
    original: false,
  });
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
    if (
      state.status !== "ready" ||
      state.kind !== "html" ||
      !state.token ||
      state.assets.length === 0
    )
      return;
    const deliver = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== "bb:inline-preview-ready" ||
        event.data.token !== state.token
      )
        return;
      window.removeEventListener("message", deliver);
      frame.current?.contentWindow?.postMessage(
        { type: INLINE_ASSET_MESSAGE, token: state.token, assets: state.assets },
        "*",
      );
    };
    window.addEventListener("message", deliver);
    return () => window.removeEventListener("message", deliver);
  }, [state, frame]);

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

  return { contentHeight, tweaks };
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
  const { contentHeight, tweaks } = useFragmentBridge(
    state,
    frame,
    updateState,
    updateTweaks,
    addContext,
    leaveWide,
  );

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
        const widget = fragment ? await restore(controller.signal) : null;
        if (cancelled) return;
        const prepared = await prepareInlineAssets(
          result.html,
          result.url,
          controller.signal,
          fragment
            ? (document, token) =>
                injectFragmentRuntime(document, {
                  token,
                  theme: readHostTheme(window.document.documentElement),
                  state: widget?.state === "null" ? null : (widget?.state ?? null),
                  tweaks: widget?.tweaks ?? null,
                })
            : undefined,
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
  }, [file, message.threadId, sdk, restore, restoreRevision]);

  if (state.status === "error") {
    return (
      <>
        <PreviewHeader file={file} expanded onToggle={onToggle} onOpen={null} />
        <Alert source={source} error>
          Failed to load {file}: {state.message}
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
          style={{ height: previewHeight ?? DEFAULT_HEIGHT_PX }}
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
    state.kind === "html" && state.fragment && !fixedHeight && contentHeight !== null
      ? Math.min(MAX_HEIGHT_PX, Math.max(MIN_FRAGMENT_HEIGHT_PX, contentHeight))
      : (previewHeight ?? DEFAULT_HEIGHT_PX);
  const actions = (
    <PreviewActions
      hasTweaks={hasTweaks}
      canShareState={canShareState}
      tweakOpen={tweakOpen}
      saving={wide && saving}
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
      />
      <div className="inline-vis-toolbar">
        <button type="button" ref={wideTrigger} onClick={() => setWide(true)}>
          Wide view
        </button>
        {actions}
      </div>
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
        <div
          className={`inline-vis-workspace${tweakOpen && tweaks.groups.length > 0 ? " inline-vis-with-tweaks" : ""}`}
        >
          <div className="inline-vis-preview">
            <PreviewDocument preview={state} frame={frame} height={height} />
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
