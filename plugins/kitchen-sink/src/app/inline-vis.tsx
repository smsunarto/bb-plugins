import { useRpc, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { InlineVisRpcContract } from "../shared/contract.ts";
import { createPreviewExpansion } from "./inline-vis-expansion.ts";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; file: string }
  | { status: "error"; message: string };

export const DEFAULT_HEIGHT_PX = 224;
export const MIN_HEIGHT_PX = 120;
export const MAX_HEIGHT_PX = 1_200;

function encodePathSegments(file: string): string {
  return file.split("/").map(encodeURIComponent).join("/");
}

export function buildWorktreePreviewUrl(threadId: string, file: string): string {
  return `/api/v1/threads/${encodeURIComponent(threadId)}/worktree/files/${encodePathSegments(file)}`;
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
  action,
  expanded,
  onToggle,
}: {
  file: string;
  action: ReactNode;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="smart-embed-header inline-vis-header" data-expanded={expanded}>
      <button
        type="button"
        className="smart-embed-open inline-vis-toggle"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} preview ${file}`}
        title={expanded ? "Collapse and unload preview" : "Expand preview"}
        onClick={onToggle}
      >
        <svg
          aria-hidden="true"
          className="inline-vis-chevron"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="m6 4 4 4-4 4" />
        </svg>
        <span className="smart-embed-kind">Preview</span>
        <span className="smart-embed-path inline-vis-path" title={file}>
          <bdi>{file}</bdi>
        </span>
        <span className="smart-embed-powered">HTML</span>
      </button>
      {action}
    </div>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      aria-hidden="true"
      className="inline-vis-open-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
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

export function InlineVisDirective({
  attributes,
  source,
  message,
  openWorkspaceFile,
}: PluginMessageDirectiveProps) {
  const file = attributes.file?.trim() ?? "";
  const height = parsePreviewHeight(attributes.height);
  if (!file)
    return (
      <Alert source={source}>
        inline-vis requires a file attribute, e.g. <code>::inline-vis{'{file="demo.html"}'}</code>
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
  const card = useRef<HTMLDivElement>(null);
  const expanded = useSyncExternalStore(expansion.subscribe, expansion.getSnapshot, () => false);
  useLayoutEffect(
    () => expansion.register(props.message.threadId, card.current!),
    [expansion, props.message.threadId],
  );
  return (
    <div ref={card} className="smart-embed inline-vis-card">
      {expanded ? (
        <ExpandedPreview {...props} onToggle={expansion.toggle} />
      ) : (
        <PreviewHeader
          file={props.attributes.file!.trim()}
          expanded={false}
          onToggle={expansion.toggle}
          action={null}
        />
      )}
    </div>
  );
}

function ExpandedPreview({
  attributes,
  source,
  message,
  openWorkspaceFile,
  onToggle,
}: PluginMessageDirectiveProps & { onToggle: () => void }) {
  const rpc = useRpc<InlineVisRpcContract>();
  const file = attributes.file?.trim() ?? "";
  const previewHeight = parsePreviewHeight(attributes.height);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const result = await rpc.call("prepareHtmlPreview", {
          threadId: message.threadId,
          file,
        });
        if (!cancelled) setState({ status: "ready", file: result.file });
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
    };
  }, [file, message.threadId, rpc]);

  if (state.status === "error") {
    return (
      <>
        <PreviewHeader file={file} action={null} expanded onToggle={onToggle} />
        <Alert source={source} error>
          Failed to load {file}: {state.message}
        </Alert>
      </>
    );
  }

  const action =
    openWorkspaceFile === null ? null : state.status === "loading" ? (
      <span aria-hidden className="inline-vis-action-placeholder" />
    ) : (
      <button
        type="button"
        aria-label={`Open ${state.file} in sidebar`}
        title="Open in sidebar"
        className="inline-vis-open"
        onClick={() => openWorkspaceFile(state.file)}
      >
        <ExternalLinkIcon />
      </button>
    );

  if (state.status === "loading") {
    return (
      <>
        <PreviewHeader file={file} action={action} expanded onToggle={onToggle} />
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
      <PreviewHeader file={state.file} action={action} expanded onToggle={onToggle} />
      <iframe
        title={`inline-vis: ${state.file}`}
        src={buildWorktreePreviewUrl(message.threadId, state.file)}
        sandbox="allow-scripts"
        style={{ height: previewHeight ?? DEFAULT_HEIGHT_PX }}
        className="inline-vis-frame"
      />
    </>
  );
}
