import {
  definePluginApp,
  experimental_Diff as Diff,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import {
  WORKSPACE_CHANGED_CHANNEL,
  workspaceChangedSignalSchema,
  type SmartEmbedsRpcContract,
  type RenderEmbedOutput,
} from "../shared/contract.ts";
import { embedCache, embedCacheKey, type EmbedRequest } from "./embed-cache.ts";
import "./app.css";
import "./timeline-motion/timeline-motion.css";
import { mountTimelineMotion } from "./timeline-motion/timeline-motion.ts";
import {
  PROBE_GROUP_TITLE,
  ThreadActivityProbe,
} from "./timeline-motion/thread-activity-probe.tsx";

type EmbedKind = "code" | "diff" | "patch";

const KIND_LABEL: Record<EmbedKind, string> = { code: "Code", diff: "Changes", patch: "Proposed" };

function positiveInteger(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function Notice({ tone, children }: { tone: "error" | "muted"; children: string }) {
  return <output className={`smart-embed-notice smart-embed-notice-${tone}`}>{children}</output>;
}

/** Free or refresh cached embeds when the server reports workspace changes. */
function useWorkspaceChangeSignals(): void {
  useRealtime(WORKSPACE_CHANGED_CHANNEL, (payload) => {
    const parsed = workspaceChangedSignalSchema.safeParse(payload);
    if (!parsed.success) return;
    const { threadId, reason } = parsed.data;
    if (reason === "archived" || reason === "deleted") embedCache.dropThread(threadId);
    else embedCache.invalidateThread(threadId);
  });

  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current === "reconnecting" && connection === "connected") {
      embedCache.invalidateAll();
    }
    previous.current = connection;
  }, [connection]);
}

function useCachedEmbed(request: EmbedRequest | null) {
  const rpc = useRpc<SmartEmbedsRpcContract>();
  const key = request === null ? null : embedCacheKey(request);
  const subscribe = useCallback(
    (listener: () => void) => (key === null ? () => {} : embedCache.subscribe(key, listener)),
    [key],
  );
  const entry = useSyncExternalStore(subscribe, () => (key === null ? null : embedCache.read(key)));

  useEffect(() => {
    if (request === null || key === null || entry === null) return;
    embedCache.touch(key);
    if (!entry.stale) return;
    void embedCache.load(
      key,
      request.threadId,
      () => rpc.call("renderEmbed", request),
      () => ({ status: "error", message: `Could not load ${request.path}.` }),
    );
  }, [entry, key, request, rpc]);

  return entry;
}

function validateRequest(
  kind: EmbedKind,
  file: string,
  path: string,
  start: number | undefined | null,
  end: number | undefined | null,
): string | null {
  return kind === "patch" && file.length === 0
    ? "This Smart Embed needs a thread-storage-relative patch file."
    : kind !== "patch" && path.length === 0
      ? "This Smart Embed needs a worktree-relative path."
      : start === null || end === null
        ? "Smart Embed lines must be positive integers."
        : null;
}

function SmartEmbed({
  kind,
  attributes,
  message,
  openWorkspaceFile,
}: PluginMessageDirectiveProps & { kind: EmbedKind }) {
  const path = attributes.path?.trim() ?? "";
  const file = attributes.file?.trim() ?? "";
  const start = positiveInteger(attributes.start);
  const end = positiveInteger(attributes.end);

  const invalid = validateRequest(kind, file, path, start, end);

  useWorkspaceChangeSignals();
  const threadId = message.threadId;
  const messageId = message.id;
  const request = useMemo<EmbedRequest | null>(
    () =>
      invalid !== null
        ? null
        : {
            kind,
            threadId,
            ...(kind === "diff" ? { messageId } : {}),
            ...(path.length > 0 ? { path } : {}),
            ...(kind === "patch" ? { file } : {}),
            ...(typeof start === "number" ? { start } : {}),
            ...(typeof end === "number" ? { end } : {}),
          },
    [end, file, invalid, kind, messageId, path, start, threadId],
  );
  const result = useCachedEmbed(request)?.value ?? null;

  return (
    <EmbedResult
      kind={kind}
      result={result}
      invalid={invalid}
      path={path}
      file={file}
      openWorkspaceFile={openWorkspaceFile}
    />
  );
}

function PendingNotice({
  result,
  subject,
}: {
  result: Exclude<RenderEmbedOutput, { status: "ready" }> | null;
  subject: string;
}) {
  const tone = result?.status === "error" ? "error" : "muted";
  return <Notice tone={tone}>{result === null ? `Loading ${subject}…` : result.message}</Notice>;
}

function EmbedResult({
  kind,
  result,
  invalid,
  path,
  file,
  openWorkspaceFile,
}: {
  kind: EmbedKind;
  result: RenderEmbedOutput | null;
  invalid: string | null;
  path: string;
  file: string;
  openWorkspaceFile: PluginMessageDirectiveProps["openWorkspaceFile"];
}) {
  if (invalid !== null) return <Notice tone="error">{invalid}</Notice>;
  const subject = kind === "patch" ? file : path;
  // The frame must exist before either the RPC or BB's lazy renderer resolves.
  // Size it by the requested kind so code/error fallbacks cannot collapse it.
  const fixedViewport = kind !== "code";
  if (fixedViewport && (result === null || result.status !== "ready")) {
    return (
      <figure className="smart-embed smart-embed-fixed" aria-busy={result === null}>
        <figcaption className="smart-embed-header">
          <span className="smart-embed-header-content">
            <span className="smart-embed-kind">{KIND_LABEL[kind]}</span>
            <span className="smart-embed-path" title={subject}>
              {subject}
            </span>
          </span>
        </figcaption>
        <div className="smart-embed-body">
          <PendingNotice result={result} subject={subject} />
        </div>
      </figure>
    );
  }
  if (result === null) return <Notice tone="muted">{`Loading ${subject}…`}</Notice>;
  if (result.status !== "ready") {
    return <Notice tone={result.status === "error" ? "error" : "muted"}>{result.message}</Notice>;
  }

  const header = (
    <>
      <span className="smart-embed-kind">{KIND_LABEL[result.kind]}</span>
      <span className="smart-embed-path" title={result.label}>
        {result.label}
      </span>
      {result.truncated ? <span className="smart-embed-warning">Truncated</span> : null}
      {result.kind !== "code" ? <span className="smart-embed-powered">Diffs</span> : null}
    </>
  );

  return (
    <figure
      className={`smart-embed${fixedViewport ? " smart-embed-fixed" : ""}`}
      data-smart-embed-kind={result.kind}
    >
      <figcaption className="smart-embed-header">
        {openWorkspaceFile === null ? (
          <span className="smart-embed-header-content">{header}</span>
        ) : (
          <button
            type="button"
            className="smart-embed-open"
            aria-label={`Open ${result.path} in the workspace`}
            onClick={() => openWorkspaceFile(result.path)}
          >
            {header}
          </button>
        )}
      </figcaption>
      <div className="smart-embed-body">
        {kind === "diff" && result.kind === "code" ? (
          <Notice tone="muted">No Git history. Showing current code.</Notice>
        ) : null}
        {result.kind === "code" ? (
          <pre className="smart-embed-code" aria-label={result.label}>
            <code>
              {result.content.split("\n").map((line, index) => {
                const lineNumber = result.startLine + index;
                return (
                  <span className="smart-embed-code-line" key={lineNumber}>
                    <span className="smart-embed-line-number" aria-hidden="true">
                      {lineNumber}
                    </span>
                    <span>{line || "\n"}</span>
                  </span>
                );
              })}
            </code>
          </pre>
        ) : (
          <Diff
            key={result.patch}
            patch={result.patch}
            path={result.path}
            view="unified"
            overflow="scroll"
            showLineNumbers
            className="smart-embed-renderer"
          />
        )}
      </div>
    </figure>
  );
}

function SmartDiffDirective(props: PluginMessageDirectiveProps) {
  return <SmartEmbed {...props} kind="diff" />;
}

function SmartCodeDirective(props: PluginMessageDirectiveProps) {
  return <SmartEmbed {...props} kind="code" />;
}

function SmartPatchDirective(props: PluginMessageDirectiveProps) {
  return <SmartEmbed {...props} kind="patch" />;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "thread-activity-probe",
    title: PROBE_GROUP_TITLE,
    component: ThreadActivityProbe,
  });
  app.contentScripts.register({
    id: "timeline-motion",
    mount: ({ signal }) => mountTimelineMotion(document, signal),
  });
  app.slots.messageDirective({ id: "smart-diff", component: SmartDiffDirective });
  app.slots.messageDirective({ id: "smart-code", component: SmartCodeDirective });
  app.slots.messageDirective({ id: "smart-patch", component: SmartPatchDirective });
});
