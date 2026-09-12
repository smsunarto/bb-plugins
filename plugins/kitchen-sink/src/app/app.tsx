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
  renderEmbedInputSchema,
  WORKSPACE_CHANGED_CHANNEL,
  workspaceChangedSignalSchema,
  type SmartEmbedsRpcContract,
  type RenderEmbedOutput,
} from "../shared/contract.ts";
import { embedCache, embedCacheKey, type EmbedRequest } from "./embed-cache.ts";
import { UnityCitationView } from "@bb-plugins/unity-inspector/app";
import { InlineVisDirective } from "./inline-vis.tsx";
import "./app.css";
import "./timeline-motion/timeline-motion.css";
import { mountTimelineMotion } from "./timeline-motion/timeline-motion.ts";
import { AutorouterAction } from "./autorouter/action.tsx";
import { AutorouterSettingsPanel } from "./autorouter/settings.tsx";
import {
  PROBE_GROUP_TITLE,
  ThreadActivityProbe,
} from "./timeline-motion/thread-activity-probe.tsx";

type SourceExcerpt = Pick<
  Extract<RenderEmbedOutput, { status: "ready"; kind: "code" }>,
  "content" | "startLine"
>;

function sourceExcerptPatch({ content, startLine }: SourceExcerpt): string {
  const lines = content.split("\n");
  return `@@ -${startLine},${lines.length} +${startLine},${lines.length} @@\n${lines.map((line) => ` ${line}`).join("\n")}\n`;
}

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

function SmartCodeDirective({
  attributes,
  message,
  openWorkspaceFile,
}: PluginMessageDirectiveProps) {
  const path = attributes.path?.trim() ?? "";
  const start = positiveInteger(attributes.start);
  const end = positiveInteger(attributes.end);
  const invalid = !path
    ? "This citation needs a worktree-relative path."
    : start === null || end === null
      ? "Citation lines must be positive integers."
      : null;
  useWorkspaceChangeSignals();
  const threadId = message.threadId;
  const workspace = attributes.workspace?.trim();
  const request = useMemo<EmbedRequest | null>(
    () =>
      invalid
        ? null
        : {
            kind: "code",
            threadId,
            path,
            ...(typeof start === "number" ? { start } : {}),
            ...(typeof end === "number" ? { end } : {}),
            ...(workspace ? { workspace } : {}),
          },
    [invalid, threadId, path, start, end, workspace],
  );
  const result = useCachedEmbed(request)?.value ?? null;
  if (invalid) return <Notice tone="error">{invalid}</Notice>;
  if (!result) return <Notice tone="muted">{`Loading ${path}…`}</Notice>;
  if (result.status !== "ready")
    return <Notice tone={result.status === "error" ? "error" : "muted"}>{result.message}</Notice>;
  if (result.kind !== "code") return <Notice tone="error">Unexpected citation response.</Notice>;
  const raw =
    result.content.length === 0 ? (
      <Notice tone="muted">Empty source.</Notice>
    ) : (
      <Diff
        patch={sourceExcerptPatch(result)}
        path={result.path}
        view="unified"
        overflow="scroll"
        showLineNumbers
        className="smart-embed-renderer"
      />
    );
  return (
    <figure className="smart-embed" data-smart-embed-kind="code">
      <CodeHeader result={result} openWorkspaceFile={openWorkspaceFile} />
      <div className="smart-embed-body">
        {result.unityNotice ? <Notice tone="muted">{result.unityNotice}</Notice> : null}
        {result.unity ? (
          <UnityCitationView citation={result.unity} path={result.path} raw={raw} />
        ) : (
          raw
        )}
      </div>
    </figure>
  );
}

function SmartChangeDirective({ attributes, message }: PluginMessageDirectiveProps) {
  return <ChangeEmbed attributes={attributes} message={message} kind="diff" />;
}
function SmartPatchDirective({ attributes, message }: PluginMessageDirectiveProps) {
  return <ChangeEmbed attributes={attributes} message={message} kind="patch" />;
}
function changeRequest(
  attributes: PluginMessageDirectiveProps["attributes"],
  message: PluginMessageDirectiveProps["message"],
  kind: "diff" | "patch",
) {
  const start = positiveInteger(attributes.start);
  const end = positiveInteger(attributes.end);
  return renderEmbedInputSchema.safeParse({
    kind,
    threadId: message.threadId,
    ...(attributes.path ? { path: attributes.path.trim() } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(attributes.workspace?.trim() ? { workspace: attributes.workspace.trim() } : {}),
    ...(kind === "patch"
      ? { file: attributes.file }
      : {
          messageId: message.id,
          ...(message.turnId ? { turnId: message.turnId } : {}),
          ...(attributes.source ? { source: attributes.source } : {}),
          ...(attributes.sha ? { sha: attributes.sha } : {}),
        }),
  });
}
function ChangeEmbed({
  attributes,
  message,
  kind,
}: Pick<PluginMessageDirectiveProps, "attributes" | "message"> & { kind: "diff" | "patch" }) {
  const parsed = changeRequest(attributes, message, kind);
  const serialized = parsed.success ? JSON.stringify(parsed.data) : null;
  const request = useMemo<EmbedRequest | null>(
    () => (serialized ? JSON.parse(serialized) : null),
    [serialized],
  );
  useWorkspaceChangeSignals();
  const result = useCachedEmbed(request)?.value;
  if (!parsed.success)
    return (
      <Notice tone="error">
        Invalid diff attributes. Supply a path, or a thread-storage .patch file, and positive line
        numbers.
      </Notice>
    );
  if (!result) return <Notice tone="muted">Loading diff…</Notice>;
  if (result.status !== "ready")
    return <Notice tone={result.status === "error" ? "error" : "muted"}>{result.message}</Notice>;
  if (result.kind === "code") return <Notice tone="error">Unexpected diff response.</Notice>;
  return (
    <figure className="smart-embed" data-smart-embed-kind={kind}>
      <figcaption className="smart-embed-header">
        <span className="smart-embed-header-content">
          <span className="smart-embed-kind">{kind === "patch" ? "Proposal" : "Diff"}</span>
          <span className="smart-embed-path">{result.label}</span>
        </span>
      </figcaption>
      <div className="smart-embed-header-content">
        <span className="smart-embed-path" title={result.source}>
          {result.source}
        </span>
      </div>
      <div className="smart-embed-body">
        {(result.files ?? [{ path: result.path, patch: result.patch }]).map((file) => (
          <div key={`${file.path}:${file.patch}`}>
            {result.files ? <div className="smart-embed-header">{file.path}</div> : null}
            <Diff
              patch={file.patch}
              path={file.path}
              view="unified"
              overflow="scroll"
              showLineNumbers
              className="smart-embed-renderer"
            />
          </div>
        ))}
      </div>
    </figure>
  );
}

type ReadyEmbed = Extract<RenderEmbedOutput, { status: "ready" }>;

function CodeHeader({
  result,
  openWorkspaceFile,
}: {
  result: Extract<ReadyEmbed, { kind: "code" }>;
  openWorkspaceFile: PluginMessageDirectiveProps["openWorkspaceFile"];
}) {
  const header = (
    <>
      <span className="smart-embed-kind">Code</span>
      <span className="smart-embed-path" title={result.label}>
        {result.label}
      </span>
      {result.workspace ? (
        <span className="smart-embed-workspace" title={`From workspace ${result.workspace}`}>
          {result.workspace}
        </span>
      ) : null}
      {result.truncated ? <span className="smart-embed-warning">Truncated</span> : null}
    </>
  );
  return (
    <figcaption className="smart-embed-header">
      {openWorkspaceFile === null || result.workspace !== undefined ? (
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
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "autorouter-settings",
    title: "Autorouter",
    icon: "Settings",
    path: "autorouter",
    component: AutorouterSettingsPanel,
  });
  app.composer.customize({
    id: "autorouter",
    scopes: ["new-thread", "thread"],
    actions: [{ id: "toggle", component: AutorouterAction }],
  });
  app.slots.experimental_threadHeaderAction({
    id: "thread-activity-probe",
    title: PROBE_GROUP_TITLE,
    component: ThreadActivityProbe,
  });
  app.contentScripts.register({
    id: "timeline-motion",
    mount: ({ signal }) => mountTimelineMotion(document, signal),
  });
  app.slots.messageDirective({ id: "smart-diff", component: SmartChangeDirective });
  app.slots.messageDirective({ id: "smart-patch", component: SmartPatchDirective });
  app.slots.messageDirective({ id: "smart-code", component: SmartCodeDirective });
  app.slots.messageDirective({ id: "inline-vis", component: InlineVisDirective });
});
