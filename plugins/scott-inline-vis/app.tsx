import {
  definePluginApp,
  experimental_usePluginId,
  Markdown,
  useBbNavigate,
  useComposer,
  useSdk,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
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

/** Fragment state lives on this client, keyed by the directive occurrence. */
function readWidgetState(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeWidgetState(key: string, state: string): void {
  try {
    window.localStorage.setItem(key, state);
  } catch {
    // Storage can be unavailable; the frame keeps its in-memory state.
  }
}

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

function ExpandedPreview({
  attributes,
  source,
  message,
  onToggle,
}: PluginMessageDirectiveProps & { onToggle: () => void }) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const composer = useComposer();
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const file = attributes.file?.trim() ?? "";
  const previewHeight = parsePreviewHeight(attributes.height);
  const fixedHeight = Boolean(attributes.height?.trim());
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const frame = useRef<HTMLIFrameElement>(null);
  const stateKey = `${pluginId}.widget-state:${message.threadId}:${message.id}:${file}`;
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
  }, [state]);

  useEffect(() => {
    if (state.status !== "ready" || state.kind !== "html" || !state.fragment || !state.token)
      return;
    const token = state.token;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = parseFrameMessage(event.data, token);
      if (data?.type === "resize") setContentHeight(data.height);
      else if (data?.type === "state") writeWidgetState(stateKey, data.state);
      // A click inside the frame also activates this page. Without one, a
      // fragment script could fill the composer on load.
      else if (data?.type === "followUp" && navigator.userActivation?.isActive === true) {
        composerRef.current.updateText((current) =>
          current.trim() ? `${current.trimEnd()}\n\n${data.prompt}` : data.prompt,
        );
        composerRef.current.focus();
      }
    };
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
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      observer.disconnect();
      cancelAnimationFrame(pending);
    };
  }, [state, stateKey]);

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
        const prepared = await prepareInlineAssets(
          result.html,
          result.url,
          controller.signal,
          fragment
            ? (document, token) =>
                injectFragmentRuntime(document, {
                  token,
                  theme: readHostTheme(window.document.documentElement),
                  state: readWidgetState(stateKey),
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
  }, [file, message.threadId, sdk, stateKey]);

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
      {state.kind === "markdown" ? (
        <div style={{ height: previewHeight ?? DEFAULT_HEIGHT_PX }} className="inline-vis-markdown">
          <Markdown content={state.content} />
        </div>
      ) : (
        <iframe
          title={`inline-vis: ${state.file}`}
          src={state.srcDoc ? undefined : state.url}
          srcDoc={state.srcDoc}
          ref={frame}
          sandbox="allow-scripts"
          style={{
            height:
              state.fragment && !fixedHeight && contentHeight !== null
                ? Math.min(MAX_HEIGHT_PX, Math.max(MIN_FRAGMENT_HEIGHT_PX, contentHeight))
                : (previewHeight ?? DEFAULT_HEIGHT_PX),
          }}
          className="inline-vis-frame"
        />
      )}
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: "inline-vis", component: InlineVisDirective });
});
