import {
  Markdown,
  useBbNavigate,
  useRpc,
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

import { type InlineVisRpcContract, type PreparePreviewOutput } from "../shared/contract.ts";
import { EmbedHeader } from "./embed-header.tsx";
import {
  INLINE_ASSET_MESSAGE,
  prepareInlineAssets,
  type InlinePreviewAsset,
} from "./inline-assets.ts";
import { previewMarkdown } from "./preview-markdown.ts";
import { createPreviewExpansion } from "./inline-vis-expansion.ts";

type MarkdownPreview = Extract<PreparePreviewOutput, { kind: "markdown" }>;

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
    }
  | {
      status: "ready";
      kind: "markdown";
      file: string;
      hostId: string;
      url: string;
      markdown: MarkdownPreview;
    }
  | { status: "error"; message: string };

export const DEFAULT_HEIGHT_PX = 224;
export const MIN_HEIGHT_PX = 120;
export const MAX_HEIGHT_PX = 1_200;

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

export function InlineVisDirective({
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
  const [expansion] = useState(createPreviewExpansion);
  const card = useRef<HTMLElement>(null);
  const expanded = useSyncExternalStore(expansion.subscribe, expansion.getSnapshot, () => false);
  useLayoutEffect(
    () => expansion.register(props.message.threadId, card.current!),
    [expansion, props.message.threadId],
  );
  return (
    <figure ref={card} className="smart-embed smart-embed-diff inline-vis-card">
      {expanded ? (
        <ExpandedPreview {...props} onToggle={expansion.toggle} />
      ) : (
        <EmbedHeader
          path={props.attributes.file!.trim()}
          label={props.attributes.file!.trim()}
          kind="preview"
          expanded={false}
          onToggle={expansion.toggle}
          openWorkspaceFile={null}
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
  const rpc = useRpc<InlineVisRpcContract>();
  const navigate = useBbNavigate();
  const file = attributes.file?.trim() ?? "";
  const previewHeight = parsePreviewHeight(attributes.height);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const frame = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => {
    if (state.status !== "ready" || state.kind !== "html" || !state.token) return;
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
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const result = await rpc.call("preparePreview", {
          threadId: message.threadId,
          file,
        });
        if (result.kind === "markdown") {
          if (!cancelled)
            setState({
              status: "ready",
              kind: "markdown",
              file: result.file,
              hostId: result.hostId,
              url: result.url,
              markdown: { ...result, content: previewMarkdown(result.content, result.url) },
            });
          return;
        }
        const videos = await prepareInlineAssets(result.html, result.url, controller.signal);
        if (!cancelled)
          setState({
            status: "ready",
            kind: "html",
            file: result.file,
            hostId: result.hostId,
            url: result.url,
            ...videos,
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
  }, [file, message.threadId, rpc]);

  if (state.status === "error") {
    return (
      <>
        <EmbedHeader
          path={file}
          label={file}
          kind="preview"
          openWorkspaceFile={null}
          expanded
          onToggle={onToggle}
        />
        <Alert source={source} error>
          Failed to load {file}: {state.message}
        </Alert>
      </>
    );
  }

  if (state.status === "loading") {
    return (
      <>
        <EmbedHeader
          path={file}
          label={file}
          kind="preview"
          openWorkspaceFile={null}
          expanded
          onToggle={onToggle}
        />
        <output
          aria-busy="true"
          aria-label={`Loading visualization ${file}`}
          style={{ height: previewHeight ?? DEFAULT_HEIGHT_PX }}
          className="inline-vis-loading"
        >
          <span className="inline-vis-skeleton" />
        </output>
      </>
    );
  }

  return (
    <>
      <EmbedHeader
        path={state.file}
        label={state.file}
        kind="preview"
        openWorkspaceFile={() =>
          navigate.experimental_openFilePreview({
            target: { kind: "host", hostId: state.hostId, path: state.file },
            location: null,
          })
        }
        expanded
        onToggle={onToggle}
      />
      {state.kind === "markdown" ? (
        <div style={{ height: previewHeight ?? DEFAULT_HEIGHT_PX }} className="inline-vis-markdown">
          <Markdown content={state.markdown.content} />
        </div>
      ) : (
        <iframe
          title={`inline-vis: ${state.file}`}
          src={state.srcDoc ? undefined : state.url}
          srcDoc={state.srcDoc}
          ref={frame}
          sandbox="allow-scripts"
          style={{ height: previewHeight ?? DEFAULT_HEIGHT_PX }}
          className="inline-vis-frame"
        />
      )}
    </>
  );
}
