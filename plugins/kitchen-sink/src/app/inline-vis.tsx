import { useRpc, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type ReactNode } from "react";

import type { InlineVisRpcContract } from "../shared/contract.ts";

type LoadState =
  | { status: "missing-file" }
  | { status: "invalid-height"; message: string }
  | { status: "loading"; file: string }
  | { status: "ready"; file: string }
  | { status: "error"; file: string; message: string };

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

function PreviewCard({
  file,
  action,
  children,
}: {
  file: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="inline-vis-card">
      <div className="inline-vis-header">
        <div className="inline-vis-heading">
          <span className="inline-vis-label">inline-vis</span>
          <span className="inline-vis-path">{file}</span>
        </div>
        {action}
      </div>
      {children}
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
  const rpc = useRpc<InlineVisRpcContract>();
  const file = attributes.file?.trim() ?? "";
  const previewHeight = parsePreviewHeight(attributes.height);
  const heightError =
    previewHeight === null
      ? `inline-vis height must be a whole number from ${MIN_HEIGHT_PX} to ${MAX_HEIGHT_PX} pixels.`
      : null;
  const [state, setState] = useState<LoadState>(() =>
    heightError
      ? { status: "invalid-height", message: heightError }
      : file
        ? { status: "loading", file }
        : { status: "missing-file" },
  );

  useEffect(() => {
    if (heightError) {
      setState({ status: "invalid-height", message: heightError });
      return;
    }
    if (!file) {
      setState({ status: "missing-file" });
      return;
    }

    let cancelled = false;
    setState({ status: "loading", file });
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
          file,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, heightError, message.threadId, rpc]);

  if (state.status === "missing-file") {
    return (
      <Alert source={source}>
        inline-vis requires a file attribute, e.g. <code>::inline-vis{'{file="demo.html"}'}</code>
      </Alert>
    );
  }

  if (state.status === "invalid-height") {
    return <Alert source={source}>{state.message}</Alert>;
  }

  if (state.status === "error") {
    return (
      <Alert source={source} error>
        Failed to load {state.file}: {state.message}
      </Alert>
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
      <PreviewCard file={state.file} action={action}>
        <output
          aria-busy="true"
          aria-label={`Loading visualization ${state.file}`}
          style={{ height: previewHeight ?? DEFAULT_HEIGHT_PX }}
          className="inline-vis-loading"
        >
          <span className="inline-vis-skeleton" />
        </output>
      </PreviewCard>
    );
  }

  return (
    <PreviewCard file={state.file} action={action}>
      <iframe
        title={`inline-vis: ${state.file}`}
        src={buildWorktreePreviewUrl(message.threadId, state.file)}
        sandbox="allow-scripts"
        style={{ height: previewHeight ?? DEFAULT_HEIGHT_PX }}
        className="inline-vis-frame"
      />
    </PreviewCard>
  );
}
