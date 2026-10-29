import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "../../components/ui/button.tsx";
import { queryClient } from "../app/query.ts";
import { queryKey, useRpcMutation, useRpcQuery } from "../app/rpc.ts";
import {
  documentBoundary,
  type DocumentFile,
  type DocumentMetadata,
  type DocumentSource,
  type StoredDocument,
} from "./model.ts";

import { DocumentTree } from "./file-tree.tsx";

type Route = {
  scope: "global" | "project";
  projectId: string;
  sourceId: string;
  path: string;
  rootHint?: string;
};
export function parseDocumentRoute(subPath: string): Route {
  let parts: string[];
  try {
    parts = subPath.split("/").map(decodeURIComponent);
  } catch {
    parts = [];
  }
  return {
    scope: parts[0] === "global" ? "global" : "project",
    projectId: parts[1] ?? "",
    sourceId: parts[2] ?? "",
    path: parts.slice(parts[1] === "at" ? 4 : 3).join("/"),
    ...(parts[1] === "at" ? { rootHint: parts[3] ?? "" } : {}),
  };
}
function routePath(source: DocumentSource, path = "") {
  return `${source.scope === "global" ? "global" : "projects"}/${source.projectId}/${source.sourceId}${path ? `/${path}` : ""}`;
}
function selected(metadata: DocumentMetadata, route: Route): DocumentSource | null {
  const projectId =
    (route.projectId === "at" ? "" : route.projectId) ||
    (route.scope === "global" ? metadata.globalProjectId : null);
  const project = metadata.projects.find(
    (p) =>
      p.id === projectId ||
      (route.projectId === "at" &&
        route.scope === "project" &&
        p.sources.some((s) => s.hostId === route.sourceId && s.rootPath === route.rootHint)),
  );
  const source =
    project?.sources.find((s) =>
      route.projectId === "at"
        ? s.hostId === route.sourceId && s.rootPath === route.rootHint
        : s.id === route.sourceId,
    ) ??
    (!route.sourceId
      ? (project?.sources.find((s) => s.isDefault) ?? project?.sources[0])
      : undefined);
  return project && source
    ? {
        scope: route.scope,
        projectId: project.id,
        sourceId: source.id,
        hostId: source.hostId,
        rootPath: source.rootPath,
      }
    : null;
}

const drafts = new Map<string, { content: string; sha256: string | null }>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function setDraft(key: string, value: { content: string; sha256: string | null } | undefined) {
  if (value) drafts.set(key, value);
  else drafts.delete(key);
  for (const listener of listeners) listener();
}
export function resetDocumentDraftsForTest() {
  drafts.clear();
  for (const listener of listeners) listener();
}
const identity = (file: DocumentFile) => JSON.stringify(file);
const selectClass =
  "w-full min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-sm";

function SourceControls({
  metadata,
  route,
  source,
}: {
  metadata: DocumentMetadata;
  route: Route;
  source: DocumentSource | null;
}) {
  const navigate = useBbNavigate();
  const client = useQueryClient();
  const configure = useRpcMutation("setGlobalProject", {
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKey("documentSources") });
      navigate.toPluginPanel("instructions", { subPath: "global" });
    },
  });
  const project = metadata.projects.find(
    (p) =>
      p.id ===
      (source?.projectId ??
        (route.scope === "global" ? metadata.globalProjectId : route.projectId)),
  );
  return (
    <div className="flex flex-wrap gap-3 border-b border-border p-4">
      <label className="min-w-0 flex-1 text-xs text-muted-foreground">
        {route.scope === "global" ? "Global source project" : "Project"}
        <select
          aria-label={route.scope === "global" ? "Global source project" : "Project"}
          className={selectClass}
          value={source?.projectId ?? ""}
          disabled={configure.isPending}
          onChange={(event) => {
            const id = event.target.value;
            if (route.scope === "global") configure.mutate({ projectId: id });
            else navigate.toPluginPanel("instructions", { subPath: `projects/${id}` });
          }}
        >
          <option value="" disabled>
            Choose a project
          </option>
          {metadata.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {project && (
        <label className="min-w-0 flex-1 text-xs text-muted-foreground">
          Checkout / machine
          <select
            aria-label="Checkout / machine"
            className={selectClass}
            value={source?.sourceId ?? ""}
            onChange={(event) => {
              const next = project.sources.find((s) => s.id === event.target.value);
              if (next)
                navigate.toPluginPanel("instructions", {
                  subPath: routePath({
                    scope: route.scope,
                    projectId: project.id,
                    sourceId: next.id,
                    hostId: next.hostId,
                    rootPath: next.rootPath,
                  }),
                });
            }}
          >
            {project.sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.hostName}
                {s.connected ? "" : " (offline)"} · {s.rootPath}
              </option>
            ))}
          </select>
        </label>
      )}
      {configure.isError && (
        <p role="alert" className="w-full text-sm text-destructive">
          {configure.error.message}
        </p>
      )}
    </div>
  );
}

function DocumentEditor({ file, online }: { file: DocumentFile; online: boolean }) {
  const read = useRpcQuery("readDocument", file, { enabled: online });
  if (read.data)
    return (
      <LoadedDocumentEditor
        file={file}
        online={online}
        stored={read.data}
        reload={() => void read.refetch()}
      />
    );
  if (read.isError)
    return (
      <div className="p-4 text-sm">
        <p role="alert">{read.error.message}</p>
        <Button size="sm" variant="outline" onClick={() => void read.refetch()}>
          Retry file
        </Button>
      </div>
    );
  return (
    <p className="p-4 text-sm">
      {online ? "Loading file…" : "No cached copy is available on this device."}
    </p>
  );
}

function LoadedDocumentEditor({
  file,
  online,
  stored,
  reload,
}: {
  file: DocumentFile;
  online: boolean;
  stored: StoredDocument;
  reload: () => void;
}) {
  const key = identity(file);
  const draft = useSyncExternalStore(subscribe, () => drafts.get(key));
  const client = useQueryClient();
  const save = useRpcMutation("saveDocument", {
    onSuccess: (result, input) => {
      if (result.outcome !== "written") return;
      const current = drafts.get(key);
      client.setQueryData(queryKey("readDocument", file), {
        content: input.content,
        sha256: result.sha256,
        readOnly: null,
      });
      if (current?.content === input.content) setDraft(key, undefined);
      else if (current) setDraft(key, { ...current, sha256: result.sha256 });
      void client.invalidateQueries({ queryKey: ["documentFiles"] });
    },
  });
  const content = draft?.content ?? stored.content;
  const changed = content !== stored.content;
  const disabled = !online || !changed || !!stored.readOnly || save.isPending;
  const discard = () => {
    setDraft(key, undefined);
    save.reset();
  };
  return (
    <section
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4"
      aria-label="File editor"
    >
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {file.scope === "global" ? "Global source" : "Project source"}
          </p>
          <h2 className="break-all font-mono text-sm font-medium">{file.path}</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!draft || save.isPending} onClick={discard}>
            Revert
          </Button>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() =>
              save.mutate({
                ...file,
                content,
                expectedSha256: draft ? draft.sha256 : stored.sha256,
              })
            }
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>
      {stored.sha256 === null && (
        <p className="text-xs text-muted-foreground">
          This file does not exist yet. Save to create it.
        </p>
      )}
      <SaveNotice
        error={save.error?.message ?? stored.readOnly}
        conflict={save.data?.outcome === "conflict"}
        reload={() => {
          discard();
          reload();
        }}
      />
      <textarea
        aria-label={file.path}
        spellCheck={false}
        readOnly={!!stored.readOnly}
        value={content}
        className="min-h-48 w-full min-w-0 flex-1 resize-none rounded-md border border-input bg-background p-3 font-mono text-sm"
        onChange={(event) =>
          setDraft(key, {
            content: event.target.value,
            sha256: draft ? draft.sha256 : stored.sha256,
          })
        }
      />
      <output className="text-xs text-muted-foreground">
        {changed ? "Unsaved changes" : save.data?.outcome === "written" ? "Saved" : "Source file"}
      </output>
      <GlobalApply file={file} disabled={!online || changed || !!stored.readOnly} />
    </section>
  );
}
function SaveNotice({
  error,
  conflict,
  reload,
}: {
  error: string | null;
  conflict: boolean;
  reload: () => void;
}) {
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  if (!conflict) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
      File changed on disk. Your draft is kept.
      <Button size="sm" variant="outline" onClick={reload}>
        Discard draft and reload
      </Button>
    </div>
  );
}
function GlobalApply({ file, disabled }: { file: DocumentFile; disabled: boolean }) {
  const apply = useRpcMutation("applyDocuments");
  const { path, ...source } = file;
  const task = path.startsWith(".dotfiles/.agents/instructions/")
    ? "render"
    : "install:agent-plugins";
  const needsApply =
    file.scope === "global" &&
    (path.startsWith(".dotfiles/.agents/instructions/") ||
      path.startsWith(".dotfiles/.agents/plugins/"));
  if (!needsApply)
    return (
      <p className="text-xs text-muted-foreground">
        Saved source files are used by new sessions; linked standalone skills may take effect
        immediately.
      </p>
    );
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>Save edits this checkout. Apply updates this machine’s installed copies.</span>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || apply.isPending}
          onClick={() => apply.mutate({ ...source, task })}
        >
          {apply.isPending
            ? "Applying…"
            : task === "render"
              ? "Apply instructions"
              : "Refresh installed skills"}
        </Button>
      </div>
      {apply.isError && (
        <p role="alert" className="text-sm text-destructive">
          {apply.error.message}
        </p>
      )}
      {apply.data && (
        <details>
          <summary>{apply.data.exitCode === 0 ? "Applied" : "Apply failed"}</summary>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">
            {apply.data.output}
          </pre>
        </details>
      )}
    </div>
  );
}

function DocumentsBody({ subPath, list = false }: PluginNavPanelProps & { list?: boolean }) {
  const route = parseDocumentRoute(subPath);
  const metadata = useRpcQuery("documentSources", null);
  if (!metadata.data)
    return (
      <p className="p-4 text-sm">
        {metadata.isError ? metadata.error.message : "Loading sources…"}
      </p>
    );
  const source = selected(metadata.data, route);
  const connected =
    source &&
    metadata.data.projects
      .find((p) => p.id === source.projectId)
      ?.sources.find((s) => s.id === source.sourceId)?.connected;
  const file = source && route.path ? { ...source, path: route.path } : null;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {!list && <SourceControls metadata={metadata.data} route={route} source={source} />}
      {!list && source?.scope === "global" && (
        <p className="px-4 pt-2 text-xs text-muted-foreground">
          Edits stay in this checkout. A receiving fleet sync may replace local changes; publish
          authoring changes before syncing.
        </p>
      )}
      {!list && (
        <Button
          size="sm"
          variant="ghost"
          className="self-end"
          onClick={() => void metadata.refetch()}
        >
          Refresh sources
        </Button>
      )}
      {source && !connected && (
        <output className="px-4 text-sm text-muted-foreground">
          This machine is offline. Cached files remain available; reconnect to save.
        </output>
      )}
      {!source ? (
        <p className="p-4 text-sm text-muted-foreground">
          Choose a source project and checkout to edit its instructions and skills.
        </p>
      ) : list ? (
        <DocumentList
          key={JSON.stringify(source)}
          source={source}
          selectedPath={route.path}
          online={!!connected}
        />
      ) : file ? (
        <div className="min-h-0 min-w-0 flex-1">
          <DocumentEditor key={identity(file)} file={file} online={!!connected} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Choose an instruction, skill, or reference file in the Files tab.
        </div>
      )}
    </div>
  );
}

function DocumentList({
  source,
  selectedPath,
  online,
}: {
  source: DocumentSource;
  selectedPath: string;
  online: boolean;
}) {
  const [query, setQuery] = useState("");
  const [newPath, setNewPath] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(query), 350);
    return () => clearTimeout(timer);
  }, [query]);
  const files = useRpcQuery("documentFiles", source, { enabled: online });
  const extra = useRpcQuery(
    "documentFiles",
    { ...source, query: settledQuery },
    { enabled: online && !!settledQuery && files.data?.truncated === true },
  );
  const paths = useMemo(
    () =>
      [...new Set([...(files.data?.files ?? []), ...(extra.data?.files ?? [])])]
        .filter((path) => path.toLowerCase().includes(query.toLowerCase()))
        .sort(),
    [files.data, extra.data, query],
  );
  const incomplete = settledQuery && extra.data ? extra.data.truncated : files.data?.truncated;

  const navigate = useBbNavigate();
  const open = (path: string) =>
    navigate.toPluginPanel("instructions", { subPath: routePath(source, path) });
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <input
        aria-label="Find instruction or skill file"
        placeholder="Find a file…"
        className={selectClass}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {files.isError && (
        <div>
          <p role="alert" className="text-sm text-destructive">
            {files.error.message}
          </p>
          <Button size="sm" variant="outline" onClick={() => void files.refetch()}>
            Retry files
          </Button>
        </div>
      )}
      {incomplete && (
        <output className="text-xs text-muted-foreground">
          Some results are omitted. Refine your search to find more files.
        </output>
      )}
      {files.data?.warnings.map((warning) => (
        <p key={warning} role="alert" className="break-words text-xs text-muted-foreground">
          {warning}
        </p>
      ))}
      <nav aria-label="Instruction and skill files" className="flex min-h-0 flex-1 flex-col">
        {!files.data && !files.isError && (
          <p className="text-sm">
            {online ? "Loading files…" : "This machine is offline and no file list is cached."}
          </p>
        )}
        <DocumentTree paths={paths} selectedPath={selectedPath} filtering={!!query} onOpen={open} />
        {files.data && paths.length === 0 && (
          <p className="p-2 text-sm text-muted-foreground">No matching files.</p>
        )}
      </nav>
      <div className="shrink-0 border-t border-border pt-2">
        <input
          aria-label="New instruction or skill file path"
          placeholder={
            source.scope === "global"
              ? ".dotfiles/.agents/skills/name/SKILL.md"
              : ".agents/skills/name/SKILL.md"
          }
          className={selectClass}
          value={newPath}
          onChange={(event) => setNewPath(event.target.value)}
        />
        <Button
          className="mt-2"
          size="sm"
          variant="outline"
          disabled={documentBoundary(source.scope, newPath) === null}
          onClick={() => open(newPath)}
        >
          New file
        </Button>
      </div>
    </div>
  );
}

export function DocumentsPage(props: PluginNavPanelProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <DocumentsBody {...props} />
    </QueryClientProvider>
  );
}
export function DocumentsTab(props: PluginNavPanelProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <DocumentsBody {...props} list />
    </QueryClientProvider>
  );
}
