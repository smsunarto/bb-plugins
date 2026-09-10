import { narrowSource } from "@smsunarto/bb-plugin-canvas/editor";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  definePluginApp,
  experimental_FileLink as FileLink,
  useBbNavigate,
  useRpc,
  useRealtime,
  type PluginFileOpenerProps,
  type PluginMessageDirectiveProps,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
  type ExperimentalLiveFileTarget,
} from "@get-bb/plugin-sdk/app";
import type { docsRpcContract } from "./server.js";
import { MarkdownEditor } from "./markdown-editor.js";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import { toast } from "sonner";
import {
  AlertCircleIcon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  Delete02Icon,
  File01Icon,
  FileAddIcon,
  FolderAddIcon,
  HtmlFile01Icon,
  PlusSignIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "./components/ui/button.js";
import { DelayedLoading } from "./components/ui/delayed-loading.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.js";
import { Input } from "./components/ui/input.js";
import { Skeleton } from "./components/ui/skeleton.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.js";
import { cn } from "./lib/utils.js";

interface Vault {
  id: string;
  name: string;
  hostId: string | null;
  rootPath: string;
}

interface Host {
  id: string;
  name: string;
  status: "connected" | "disconnected";
}

interface VaultEntry {
  kind: "file" | "directory";
  path: string;
}

interface NoteSummary {
  path: string;
  title: string;
  preview: string;
  modifiedAtMs: number;
}

interface NotesData {
  vaults: Vault[];
  vault: Vault;
  hosts: Host[];
  entries: VaultEntry[];
  entryOrder: string[];
  notes: NoteSummary[];
  truncated: boolean;
  error: string | null;
}

interface PreviewLease {
  baseUrl: string;
  expiresAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function dirname(value: string): string {
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

type DocsRpcClient = ReturnType<typeof useRpc<typeof docsRpcContract>>;

interface NotebookStore {
  consumers: Set<symbol>;
  data: NotesData | null;
  error: string | null;
  inFlight: Promise<void> | null;
  listeners: Set<() => void>;
  owner: symbol | null;
  pendingRefreshRpc: DocsRpcClient | null;
  requestId: number;
  vaultId: string | null;
}

const notebookStores = new Map<string | null, NotebookStore>();

function getNotebookStore(vaultId: string | null): NotebookStore {
  const existing = notebookStores.get(vaultId);
  if (existing) return existing;
  const store: NotebookStore = {
    consumers: new Set(),
    data: null,
    error: null,
    inFlight: null,
    listeners: new Set(),
    owner: null,
    pendingRefreshRpc: null,
    requestId: 0,
    vaultId,
  };
  notebookStores.set(vaultId, store);
  return store;
}

function notifyNotebookStore(store: NotebookStore): void {
  for (const listener of store.listeners) listener();
}

function refreshNotebookStore(
  store: NotebookStore,
  rpc: DocsRpcClient,
  { queueIfInFlight = true }: { queueIfInFlight?: boolean } = {},
): Promise<void> {
  if (notebookStores.get(store.vaultId) !== store) return Promise.resolve();
  if (store.inFlight) {
    if (queueIfInFlight) store.pendingRefreshRpc = rpc;
    return store.inFlight;
  }
  if (store.error !== null) {
    store.error = null;
    notifyNotebookStore(store);
  }
  const requestId = ++store.requestId;
  const request = rpc
    .call("listNotes", store.vaultId ? { vaultId: store.vaultId } : {})
    .then((value) => {
      if (requestId !== store.requestId || notebookStores.get(store.vaultId) !== store) return;
      store.data = value;
      store.error = null;
      notifyNotebookStore(store);
    })
    .catch((error: unknown) => {
      if (requestId !== store.requestId || notebookStores.get(store.vaultId) !== store) return;
      const message = error instanceof Error ? error.message : String(error);
      if (store.data === null) store.error = message;
      else store.data = { ...store.data, error: message };
      notifyNotebookStore(store);
    })
    .finally(() => {
      if (store.inFlight !== request) return;
      store.inFlight = null;
      const pendingRefreshRpc = store.pendingRefreshRpc;
      store.pendingRefreshRpc = null;
      if (
        pendingRefreshRpc !== null &&
        store.consumers.size > 0 &&
        notebookStores.get(store.vaultId) === store
      ) {
        void refreshNotebookStore(store, pendingRefreshRpc, {
          queueIfInFlight: false,
        });
      }
    });
  store.inFlight = request;
  return request;
}

function useNotebook(vaultId: string | null) {
  const rpc = useRpc<typeof docsRpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const store = useMemo(() => getNotebookStore(vaultId), [vaultId]);
  const consumerRef = useRef(Symbol("docs-notebook-consumer"));
  const [, rerender] = useState(0);
  const refresh = useCallback(() => {
    void refreshNotebookStore(store, rpcRef.current);
  }, [store]);

  useEffect(() => {
    const consumer = consumerRef.current;
    const listener = () => rerender((version) => version + 1);
    store.consumers.add(consumer);
    store.listeners.add(listener);
    store.owner ??= consumer;
    if (store.data === null) {
      void refreshNotebookStore(store, rpcRef.current, {
        queueIfInFlight: false,
      });
    }
    return () => {
      store.consumers.delete(consumer);
      store.listeners.delete(listener);
      if (store.owner === consumer) store.owner = store.consumers.values().next().value ?? null;
      if (store.consumers.size === 0) {
        queueMicrotask(() => {
          if (store.consumers.size !== 0 || notebookStores.get(store.vaultId) !== store) return;
          store.requestId += 1;
          store.pendingRefreshRpc = null;
          notebookStores.delete(store.vaultId);
        });
      }
    };
  }, [store]);

  useRealtime(
    "vault-changed",
    useCallback(() => {
      if (store.owner === consumerRef.current) refresh();
    }, [refresh, store]),
  );

  const data =
    store.data && (vaultId === null || store.data.vault.id === vaultId) ? store.data : null;
  return { data, error: store.error, refresh };
}

function DocumentSkeleton() {
  return (
    <DelayedLoading>
      <output className="min-w-0 flex-1 overflow-hidden" aria-label="Loading document">
        <span className="sr-only">Loading…</span>
        <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-12">
          <div className="space-y-4">
            <Skeleton className="h-8 w-2/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-4/5" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <div className="space-y-4 pt-2">
            <Skeleton className="h-6 w-1/3" />
            <div className="space-y-3">
              {["w-11/12", "w-4/5", "w-2/3"].map((width) => (
                <div className="flex items-center gap-3" key={width}>
                  <Skeleton className="size-4 shrink-0" />
                  <Skeleton className={cn("h-4", width)} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </output>
    </DelayedLoading>
  );
}

interface DocumentRef {
  vaultId: string;
  path: string;
  title: string;
}

function documentTitle(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(/\.(mdx?|markdown|html?)$/i, "");
}

function parseDocumentRef(value: unknown): DocumentRef | null {
  if (!isRecord(value)) return null;
  const vaultId =
    typeof value.vaultId === "string"
      ? value.vaultId
      : typeof value.vault === "string"
        ? value.vault
        : "";
  const path = typeof value.path === "string" ? value.path : "";
  const title =
    typeof value.title === "string" && value.title.trim()
      ? value.title.trim()
      : documentTitle(path);
  if (
    !vaultId ||
    !path ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    !/\.(mdx?|markdown|html?)$/i.test(path)
  )
    return null;
  return { vaultId, path, title };
}

function DocsDirectiveCard({ attributes }: PluginMessageDirectiveProps) {
  const navigate = useBbNavigate();
  const document = parseDocumentRef(attributes);
  if (!document) {
    return (
      <div className="my-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        Invalid Docs link. Expected a vault and a Markdown or HTML path.
      </div>
    );
  }
  const openInDocs = () =>
    navigate.toPluginPanel("docs", {
      subPath: `${document.vaultId}/${document.path}`,
    });
  const openPreview = () => {
    const opened = navigate.openThreadPanel({
      actionId: "document",
      title: document.title,
      params: {
        vaultId: document.vaultId,
        path: document.path,
        title: document.title,
      },
    });
    if (!opened) openInDocs();
  };
  return (
    <div className="my-3 flex h-11 items-center gap-1 rounded-lg border border-border bg-card px-2 shadow-sm transition-colors hover:bg-state-hover">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={openPreview}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <HugeiconsIcon
            icon={/\.html?$/i.test(document.path) ? HtmlFile01Icon : File01Icon}
            className="size-4"
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{document.title}</span>
      </button>
      <Button
        className="size-8 shrink-0"
        size="icon"
        variant="ghost"
        aria-label="Open in Docs"
        onClick={openInDocs}
      >
        <HugeiconsIcon icon={ArrowUpRight01Icon} />
      </Button>
    </div>
  );
}

function HtmlDocumentPanelBody({ document }: { document: DocumentRef }) {
  const rpc = useRpc<typeof docsRpcContract>();
  const [state, setState] = useState<PreviewLease | { error: string } | null>(null);
  useEffect(() => {
    let active = true;
    setState(null);
    rpc
      .call("preparePreview", {
        vaultId: document.vaultId,
        path: document.path,
      })
      .then((lease) => {
        if (active) setState(lease);
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      active = false;
    };
  }, [document.path, document.vaultId, rpc]);
  if (!state) return <DocumentSkeleton />;
  if ("error" in state) return <div className="text-sm text-destructive">{state.error}</div>;
  return (
    <iframe
      className="min-h-[32rem] flex-1 border-0 bg-white"
      sandbox="allow-scripts"
      title={document.title}
      src={`${state.baseUrl}/${encodePath(document.path)}`}
    />
  );
}

function DocumentPanel({ params }: PluginThreadPanelProps) {
  const document = parseDocumentRef(params);
  const navigate = useBbNavigate();
  if (!document)
    return (
      <div className="text-sm text-muted-foreground">
        Open a Docs card from a message to edit it here.
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pb-2">
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{document.title}</div>
        <Button
          className="size-8 shrink-0"
          size="icon"
          variant="ghost"
          aria-label="Open in Docs"
          onClick={() =>
            navigate.toPluginPanel("docs", {
              subPath: `${document.vaultId}/${document.path}`,
            })
          }
        >
          <HugeiconsIcon icon={ArrowUpRight01Icon} />
        </Button>
      </div>
      {/\.html?$/i.test(document.path) ? (
        <HtmlDocumentPanelBody document={document} />
      ) : (
        <NotePane
          vaultId={document.vaultId}
          notePath={document.path}
          onChanged={() => undefined}
          onRenamed={() => undefined}
          renameToTitle={false}
        />
      )}
    </div>
  );
}

function NotePane({
  vaultId,
  notePath,
  onChanged,
  onRenamed,
  renameToTitle = true,
}: {
  vaultId: string;
  notePath: string;
  onChanged(): void;
  onRenamed(path: string): void;
  renameToTitle?: boolean;
}) {
  const rpc = useRpc<typeof docsRpcContract>();
  const { data: notebook } = useNotebook(vaultId);
  const [state, setState] = useState<
    { content: string; lease: PreviewLease } | { error: string } | null
  >(null);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const markdownRef = useRef("");
  const savedRef = useRef("");
  const shaRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pathRef = useRef(notePath);
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const renamedRef = useRef(onRenamed);
  renamedRef.current = onRenamed;

  useEffect(() => {
    let active = true;
    setState(null);
    Promise.all([
      rpc.call("readNote", { vaultId, path: notePath }),
      rpc.call("preparePreview", { vaultId, path: notePath }),
    ])
      .then(([file, lease]) => {
        if (!active) return;
        pathRef.current = notePath;
        markdownRef.current = file.content;
        savedRef.current = file.content;
        shaRef.current = file.sha256;
        setState({ content: file.content, lease });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      active = false;
    };
  }, [notePath, rpc, vaultId]);

  const save = useCallback(
    async (force = false) => {
      if (savingRef.current || (!force && markdownRef.current === savedRef.current)) return;
      savingRef.current = true;
      setSaveError(null);
      const content = markdownRef.current;
      try {
        const value = await rpc.call("saveNote", {
          vaultId,
          path: pathRef.current,
          content,
          ...(!force && shaRef.current ? { expectedSha256: shaRef.current } : {}),
        });
        const result = value;
        if (result.outcome === "conflict") {
          setConflict(true);
          return;
        }
        savedRef.current = content;
        shaRef.current = result.sha256;
        setConflict(false);
        changedRef.current();
        if (renameToTitle) {
          const renamed = await rpc.call("renameToTitle", {
            vaultId,
            path: pathRef.current,
          });
          if (renamed.path !== pathRef.current) {
            pathRef.current = renamed.path;
            renamedRef.current(renamed.path);
          }
        }
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error));
      } finally {
        savingRef.current = false;
      }
    },
    [renameToTitle, rpc, vaultId],
  );

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void save(), 700);
  }, [save]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void save();
    },
    [save],
  );

  if (!state) return <DocumentSkeleton />;
  if ("error" in state)
    return <div className="min-w-0 flex-1 p-6 text-sm text-destructive">{state.error}</div>;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {conflict ? (
        <div className="flex items-center gap-2 border-b border-border bg-muted px-4 py-2 text-xs">
          Changed on disk.
          <Button size="sm" variant="ghost" onClick={() => location.reload()}>
            Reload
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void save(true)}>
            Overwrite
          </Button>
        </div>
      ) : null}
      {saveError ? (
        <div className="border-b border-border px-4 py-2 text-xs text-destructive">{saveError}</div>
      ) : null}
      <MarkdownEditor
        initialValue={state.content}
        previewBaseUrl={state.lease.baseUrl}
        notePath={notePath}
        canvasSource={
          notebook
            ? {
                kind: "host",
                hostId: notebook.vault.hostId,
                path: `${notebook.vault.rootPath.replace(/[\\/]$/, "")}/${notePath}`,
              }
            : undefined
        }
        onUpload={async (file) => {
          const content = await fileToBase64(file);
          const value = await rpc.call("uploadAttachment", {
            vaultId,
            notePath: pathRef.current,
            name: file.name,
            content,
          });
          return { markdownPath: value.markdownPath };
        }}
        onFirstRender={(markdown) => {
          markdownRef.current = markdown;
          savedRef.current = markdown;
        }}
        onProposalApplied={({ content, sha256 }) => {
          if (timerRef.current) clearTimeout(timerRef.current);
          markdownRef.current = content;
          savedRef.current = content;
          shaRef.current = sha256;
          setState((previous) =>
            previous && !("error" in previous) ? { ...previous, content } : previous,
          );
        }}
        onMarkdownChange={(markdown) => {
          markdownRef.current = markdown;
          scheduleSave();
        }}
      />
    </div>
  );
}

function DocsFileOpener(props: PluginFileOpenerProps) {
  return <DocsFileOpenerSession key={JSON.stringify([props.source, props.path])} {...props} />;
}

function DocsFileOpenerSession({ path: filePath, source }: PluginFileOpenerProps) {
  const canvasSourceResult = narrowSource(source, filePath);
  const rpc = useRpc<typeof docsRpcContract>();
  const navigate = useBbNavigate();
  const liveFileTarget = useMemo<ExperimentalLiveFileTarget | null>(() => {
    switch (source.kind) {
      case "workspace":
        return source.environmentId === null
          ? null
          : {
              kind: source.kind,
              environmentId: source.environmentId,
              path: filePath,
            };
      case "host":
        return source.experimental_hostId === undefined
          ? null
          : {
              kind: source.kind,
              hostId: source.experimental_hostId,
              path: filePath,
            };
      case "thread-storage":
        return source.threadId === null
          ? null
          : { kind: source.kind, threadId: source.threadId, path: filePath };
    }
  }, [filePath, source]);
  const openerSource = useMemo(
    () => ({
      kind: source.kind,
      threadId: source.threadId,
      environmentId: source.environmentId,
      projectId: source.projectId,
      ...(source.experimental_hostId === undefined
        ? {}
        : { experimental_hostId: source.experimental_hostId }),
    }),
    [
      source.environmentId,
      source.experimental_hostId,
      source.kind,
      source.projectId,
      source.threadId,
    ],
  );
  const [state, setState] = useState<
    { content: string; lease: PreviewLease; previewPath: string } | { error: string } | null
  >(null);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const markdownRef = useRef("");
  const savedRef = useRef("");
  const shaRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    let active = true;
    setState(null);
    setConflict(false);
    setSaveError(null);
    void rpc
      .call("openFile", { source: openerSource, path: filePath })
      .then(({ file, preview, previewPath }) => {
        if (!active) return;
        markdownRef.current = file.content;
        savedRef.current = file.content;
        shaRef.current = file.sha256;
        setState({ content: file.content, lease: preview, previewPath });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [filePath, openerSource, reloadNonce, rpc]);

  useEffect(() => {
    if (!state || "error" in state) return;
    let active = true;
    let pending = false;
    const timer = setInterval(async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      const knownSha = shaRef.current;
      try {
        const file = await rpc.call("readOpenedFile", { source: openerSource, path: filePath });
        if (!active || shaRef.current !== knownSha || file.sha256 === knownSha) return;
        if (savingRef.current || markdownRef.current !== savedRef.current) {
          setConflict(true);
          return;
        }
        markdownRef.current = file.content;
        savedRef.current = file.content;
        shaRef.current = file.sha256;
        setState((previous) =>
          previous && !("error" in previous) ? { ...previous, content: file.content } : previous,
        );
      } catch {
        // Keep the editable document during a temporary host disconnect. The
        // next read retries, and a write still reports conflicts or failures.
      } finally {
        pending = false;
      }
    }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [filePath, openerSource, rpc, state]);

  const save = useCallback(
    async (force = false) => {
      if (savingRef.current || (!force && markdownRef.current === savedRef.current)) return;
      savingRef.current = true;
      setSaveError(null);
      const content = markdownRef.current;
      try {
        const result = await rpc.call("saveOpenedFile", {
          source: openerSource,
          path: filePath,
          content,
          ...(!force && shaRef.current ? { expectedSha256: shaRef.current } : {}),
        });
        if (result.outcome === "conflict") {
          setConflict(true);
          return;
        }
        savedRef.current = content;
        shaRef.current = result.sha256;
        setConflict(false);
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error));
      } finally {
        savingRef.current = false;
      }
    },
    [filePath, openerSource, rpc],
  );

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void save(), 700);
  }, [save]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void save();
    },
    [save],
  );

  if (!state) return <DocumentSkeleton />;
  if ("error" in state) {
    return (
      <div className="min-w-0 flex-1 p-6 text-sm text-destructive">
        {state.error} — use the tab&apos;s Open with menu to choose another viewer.
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {liveFileTarget === null ? null : (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
          <FileLink className="min-w-0 flex-1 truncate" target={liveFileTarget}>
            {filePath}
          </FileLink>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label="Open file externally"
            onClick={() =>
              navigate.experimental_openFileExternally({
                target: liveFileTarget,
                location: null,
              })
            }
          >
            <HugeiconsIcon icon={ArrowUpRight01Icon} className="size-4" />
          </Button>
        </div>
      )}
      {conflict ? (
        <div className="flex items-center gap-2 border-b border-border bg-muted px-4 py-2 text-xs">
          Changed on disk.
          <Button size="sm" variant="ghost" onClick={() => setReloadNonce((value) => value + 1)}>
            Reload
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void save(true)}>
            Overwrite
          </Button>
        </div>
      ) : null}
      {saveError ? (
        <div className="border-b border-border px-4 py-2 text-xs text-destructive">{saveError}</div>
      ) : null}
      <MarkdownEditor
        initialValue={state.content}
        previewBaseUrl={state.lease.baseUrl}
        notePath={state.previewPath}
        canvasSource={canvasSourceResult.ok ? canvasSourceResult.value : undefined}
        onUpload={async () => {
          throw new Error("Add this file to a Docs vault before uploading images");
        }}
        onFirstRender={(markdown) => {
          markdownRef.current = markdown;
          savedRef.current = markdown;
        }}
        onProposalApplied={({ content, sha256 }) => {
          if (timerRef.current) clearTimeout(timerRef.current);
          markdownRef.current = content;
          savedRef.current = content;
          shaRef.current = sha256;
          setState((previous) =>
            previous && !("error" in previous) ? { ...previous, content } : previous,
          );
        }}
        onMarkdownChange={(markdown) => {
          markdownRef.current = markdown;
          scheduleSave();
        }}
      />
    </div>
  );
}

function HtmlPane({ vaultId, filePath }: { vaultId: string; filePath: string }) {
  const rpc = useRpc<typeof docsRpcContract>();
  const [lease, setLease] = useState<PreviewLease | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLease(null);
    setError(null);
    void rpc
      .call("preparePreview", { vaultId, path: filePath })
      .then((value) => setLease(value))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [filePath, rpc, vaultId]);
  if (error) return <div className="min-w-0 flex-1 p-6 text-sm text-destructive">{error}</div>;
  if (!lease) return <DocumentSkeleton />;
  return (
    <iframe
      className="min-h-0 flex-1 border-0 bg-white"
      sandbox="allow-scripts"
      title={filePath}
      src={`${lease.baseUrl}/${encodePath(filePath)}`}
    />
  );
}

function orderEntries(entries: VaultEntry[], entryOrder: readonly string[]): VaultEntry[] {
  const orderByPath = new Map(entryOrder.map((entryPath, index) => [entryPath, index]));
  const children = new Map<string, VaultEntry[]>();
  for (const entry of entries) {
    const parent = dirname(entry.path);
    const siblings = children.get(parent) ?? [];
    siblings.push(entry);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      if (left.kind === "file") {
        const leftOrder = orderByPath.get(left.path);
        const rightOrder = orderByPath.get(right.path);
        if (leftOrder !== undefined || rightOrder !== undefined) {
          if (leftOrder === undefined) return 1;
          if (rightOrder === undefined) return -1;
          if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        }
      }
      const leftName = left.path.split("/").at(-1) ?? left.path;
      const rightName = right.path.split("/").at(-1) ?? right.path;
      return leftName.localeCompare(rightName, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
  }
  const ordered: VaultEntry[] = [];
  const visit = (parent: string) => {
    for (const entry of children.get(parent) ?? []) {
      ordered.push(entry);
      if (entry.kind === "directory") visit(entry.path);
    }
  };
  visit("");
  return ordered;
}

interface NotesSidebarNavigationProps {
  query: string;
  searchOpen: boolean;
  onQueryChange(value: string): void;
  onSearchOpenChange(open: boolean): void;
  onNewNote(): void;
  onNewFolder(): void;
}

function NotesSidebarNavigation(props: NotesSidebarNavigationProps) {
  return (
    <div
      role="toolbar"
      aria-label="Notes sidebar actions"
      className="flex min-w-0 flex-1 items-center gap-1"
    >
      {props.searchOpen ? (
        <>
          <div className="relative min-w-0 flex-1">
            <HugeiconsIcon
              icon={Search01Icon}
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              className="h-8 pl-8"
              value={props.query}
              onChange={(event) => props.onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                props.onQueryChange("");
                props.onSearchOpenChange(false);
              }}
              placeholder="Search this vault"
            />
          </div>
          <Button
            className="size-8"
            size="icon"
            variant="ghost"
            aria-label="Close search"
            onClick={() => {
              props.onQueryChange("");
              props.onSearchOpenChange(false);
            }}
          >
            <HugeiconsIcon icon={Cancel01Icon} />
          </Button>
        </>
      ) : null}
      {!props.searchOpen ? (
        <>
          <Button
            className="size-8"
            size="icon"
            variant="ghost"
            aria-label="Search notes"
            onClick={() => props.onSearchOpenChange(true)}
          >
            <HugeiconsIcon icon={Search01Icon} />
          </Button>
          <Button
            className="size-8"
            size="icon"
            variant="ghost"
            aria-label="New note"
            onClick={props.onNewNote}
          >
            <HugeiconsIcon icon={FileAddIcon} />
          </Button>
          <Button
            className="size-8"
            size="icon"
            variant="ghost"
            aria-label="New folder"
            onClick={props.onNewFolder}
          >
            <HugeiconsIcon icon={FolderAddIcon} />
          </Button>
          <span className="min-w-0 flex-1" />
        </>
      ) : null}
    </div>
  );
}

function Tree({
  data,
  selectedPath,
  onOpen,
  onNewNote,
  onNewFolder,
  onDeleteFile,
  onMoveFile,
  onVaultChange,
  onAddVault,
}: {
  data: NotesData;
  selectedPath: string | null;
  onOpen(path: string): void;
  onNewNote(): void;
  onNewFolder(): void;
  onDeleteFile(path: string): void;
  onMoveFile(sourcePath: string, targetFolder: string): void;
  onVaultChange(vaultId: string): void;
  onAddVault(): void;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const notesByPath = useMemo(
    () => new Map(data.notes.map((note) => [note.path, note])),
    [data.notes],
  );
  const selectedHost = data.vault.hostId
    ? data.hosts.find((host) => host.id === data.vault.hostId)
    : null;
  const hostUnavailable = Boolean(data.vault.hostId && selectedHost?.status !== "connected");

  const orderedEntries = useMemo(
    () => orderEntries(data.entries, data.entryOrder),
    [data.entries, data.entryOrder],
  );
  const treePaths = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const included = new Set<string>();
    if (needle) {
      for (const entry of orderedEntries) {
        const note = notesByPath.get(entry.path);
        if (
          entry.path.toLowerCase().includes(needle) ||
          note?.title.toLowerCase().includes(needle) ||
          note?.preview.toLowerCase().includes(needle)
        ) {
          included.add(entry.path);
          const parents = entry.path.split("/").slice(0, -1);
          let parent = "";
          for (const part of parents) {
            parent = parent ? `${parent}/${part}` : part;
            included.add(parent);
          }
        }
      }
    }
    return orderedEntries
      .filter((entry) => !needle || included.has(entry.path))
      .map((entry) => (entry.kind === "directory" ? `${entry.path}/` : entry.path));
  }, [notesByPath, orderedEntries, query]);
  const directoryPaths = useMemo(() => treePaths.filter((path) => path.endsWith("/")), [treePaths]);
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onMoveFileRef = useRef(onMoveFile);
  onMoveFileRef.current = onMoveFile;

  const { model } = useFileTree({
    paths: treePaths,
    presorted: true,
    initialExpansion: "open",
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: 28,
    density: "compact",
    icons: "standard",
    search: false,
    stickyFolders: false,
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: "both",
        buttonVisibility: "when-needed",
      },
    },
    onSelectionChange: (paths) => {
      const path = paths.at(-1);
      if (!path || path.endsWith("/") || path === selectedPathRef.current) return;
      onOpenRef.current(path);
    },
    dragAndDrop: {
      canDrag: (paths) => paths.length === 1 && !paths[0]?.endsWith("/"),
      canDrop: ({ draggedPaths, target }) => {
        if (draggedPaths.length !== 1) return false;
        const sourcePath = draggedPaths[0];
        if (!sourcePath || sourcePath.endsWith("/")) return false;
        const targetFolder = (target.directoryPath ?? "").replace(/\/$/, "");
        return dirname(sourcePath) !== targetFolder;
      },
      onDropComplete: ({ draggedPaths, target }) => {
        const sourcePath = draggedPaths[0];
        if (!sourcePath) return;
        const targetFolder = (target.directoryPath ?? "").replace(/\/$/, "");
        onMoveFileRef.current(sourcePath, targetFolder);
      },
      onDropError: (message) => toast.error(message),
    },
  });

  useEffect(() => {
    model.resetPaths(treePaths, { initialExpandedPaths: directoryPaths });
    const current = selectedPathRef.current;
    if (current && treePaths.includes(current)) {
      for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
      model.getItem(current)?.select();
    }
  }, [directoryPaths, model, treePaths]);

  useEffect(() => {
    if (selectedPath) {
      for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
      model.getItem(selectedPath)?.select();
      model.scrollToPath(selectedPath, { offset: "nearest" });
      return;
    }
    for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
  }, [model, selectedPath]);

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-sidebar"
      style={{ fontFamily: '"SN Pro", var(--font-sans)' }}
    >
      <div className="flex items-center gap-1 p-2">
        <NotesSidebarNavigation
          query={query}
          searchOpen={searchOpen}
          onQueryChange={setQuery}
          onSearchOpenChange={setSearchOpen}
          onNewNote={onNewNote}
          onNewFolder={onNewFolder}
        />
      </div>
      <nav aria-label="Notes" className="relative flex min-h-0 flex-1 flex-col">
        {data.error ? <div className="p-3 text-xs text-destructive">{data.error}</div> : null}
        <PierreFileTree
          aria-label="Notes file tree"
          className="block min-h-0 w-full flex-1"
          data-docs-tree=""
          model={model}
          renderContextMenu={(item, context) =>
            item.kind === "file" ? (
              <div
                className="z-50 min-w-32 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
                data-file-tree-context-menu-root="true"
                role="menu"
              >
                <button
                  className="flex w-full select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-destructive outline-none hover:bg-destructive/15 focus:bg-destructive/15 focus:text-destructive"
                  onClick={() => {
                    context.close({ restoreFocus: false });
                    onDeleteFile(item.path);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <HugeiconsIcon icon={Delete02Icon} className="size-4" />
                  Delete
                </button>
              </div>
            ) : null
          }
          style={
            {
              "--trees-bg-override": "var(--sidebar)",
              "--trees-fg-override": "var(--sidebar-foreground)",
              "--trees-fg-muted-override": "var(--muted-foreground)",
              "--trees-selected-bg-override": "var(--sidebar-accent)",
              "--trees-selected-fg-override": "var(--sidebar-accent-foreground)",
              "--trees-border-color-override": "transparent",
              "--trees-indent-guide-bg-override": "var(--border)",
              "--trees-focus-ring-color-override": "var(--ring)",
              "--trees-font-family-override": '"SN Pro", var(--font-sans)',
              "--trees-font-size-override": "14px",
              "--trees-item-margin-x-override": "6px",
              "--trees-padding-inline-override": "0px",
              height: "100%",
            } as CSSProperties
          }
        />
        {data.truncated ? (
          <div className="p-2 text-xs text-muted-foreground">Tree truncated at 5,000 entries.</div>
        ) : null}
      </nav>
      <div className="grid gap-1.5 border-t border-border p-2">
        <div className="flex items-center gap-1">
          <Select value={data.vault.id} onValueChange={onVaultChange}>
            <SelectTrigger
              className="min-w-0 flex-1 border-transparent px-2 shadow-none hover:bg-state-hover"
              aria-label="Vault"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {data.vaults.map((vault) => (
                <SelectItem key={vault.id} value={vault.id}>
                  {vault.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            className="size-8 shrink-0"
            size="icon"
            variant="ghost"
            aria-label="Add vault"
            onClick={onAddVault}
          >
            <HugeiconsIcon icon={PlusSignIcon} />
          </Button>
        </div>
        {hostUnavailable ? (
          <output className="flex items-center gap-1.5 px-1 text-xs text-destructive">
            <HugeiconsIcon icon={AlertCircleIcon} className="size-4 shrink-0" />
            <span className="truncate">Host unavailable</span>
          </output>
        ) : null}
      </div>
    </div>
  );
}

function parseRoute(subPath: string): {
  vaultId: string | null;
  filePath: string | null;
} {
  if (!subPath) return { vaultId: null, filePath: null };
  const parts = subPath.split("/").map(decodeURIComponent);
  if (parts.length === 1 && /\.(mdx?|markdown|html?)$/i.test(parts[0] ?? "")) {
    return { vaultId: null, filePath: parts[0] ?? null };
  }
  return {
    vaultId: parts.shift() ?? null,
    filePath: parts.length ? parts.join("/") : null,
  };
}

function NotesWorkspace({
  subPath,
  navigationOnly,
}: PluginNavPanelProps & { navigationOnly: boolean }) {
  const rpc = useRpc<typeof docsRpcContract>();
  const navigate = useBbNavigate();
  const route = parseRoute(subPath);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const [vaultName, setVaultName] = useState("");
  const [vaultRootPath, setVaultRootPath] = useState("");
  const [vaultHostId, setVaultHostId] = useState("primary");
  const [vaultError, setVaultError] = useState<string | null>(null);
  const { data, error, refresh } = useNotebook(route.vaultId);
  const activeVaultId = data?.vault.id ?? route.vaultId;
  const filePath = route.filePath;
  const currentVaultIdRef = useRef(activeVaultId);
  currentVaultIdRef.current = activeVaultId;
  const isCurrentVault = useCallback(
    (vaultId: string) => currentVaultIdRef.current === vaultId,
    [],
  );

  const open = useCallback(
    (path: string, replace = false) => {
      if (!activeVaultId || !isCurrentVault(activeVaultId)) return;
      navigate.toPluginPanel("docs", {
        subPath: `${activeVaultId}/${path}`,
        replace,
      });
    },
    [activeVaultId, isCurrentVault, navigate],
  );

  if (!data || !activeVaultId) {
    if (error)
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
          <p className="text-destructive">Could not load vaults: {error}</p>
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      );
    return (
      <DelayedLoading>
        <output className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Loading vaults…
        </output>
      </DelayedLoading>
    );
  }

  const selectedFolder = filePath ? dirname(filePath) : "";
  const newNote = () =>
    void rpc
      .call("createNote", {
        vaultId: activeVaultId,
        parent: selectedFolder,
        name: "Untitled",
      })
      .then((value) => {
        if (isCurrentVault(activeVaultId)) {
          refresh();
          open(value.path);
        }
      });
  const createFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    setFolderError(null);
    const target = selectedFolder ? `${selectedFolder}/${name}` : name;
    try {
      await rpc.call("createFolder", { vaultId: activeVaultId, path: target });
      if (!isCurrentVault(activeVaultId)) return;
      setFolderName("");
      setFolderDialogOpen(false);
      refresh();
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : String(error));
    }
  };

  const createVault = async () => {
    const name = vaultName.trim();
    const rootPath = vaultRootPath.trim();
    if (!name || !rootPath) return;
    setVaultError(null);
    try {
      const value = await rpc.call("createVault", {
        name,
        rootPath,
        ...(vaultHostId === "primary" ? {} : { hostId: vaultHostId }),
      });
      if (!isCurrentVault(activeVaultId)) return;
      setVaultName("");
      setVaultRootPath("");
      setVaultHostId("primary");
      setVaultDialogOpen(false);
      navigate.toPluginPanel("docs", {
        subPath: value.id,
      });
    } catch (error) {
      setVaultError(error instanceof Error ? error.message : String(error));
    }
  };

  const deleteFile = async (path: string) => {
    try {
      await rpc.call("deletePath", {
        vaultId: activeVaultId,
        path,
      });
      if (!isCurrentVault(activeVaultId)) return;
      refresh();
      if (filePath === path) {
        navigate.toPluginPanel("docs", {
          subPath: activeVaultId,
          replace: true,
        });
      }
      toast.success(`Deleted ${path}`);
    } catch (error) {
      toast.error(
        `Could not delete ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const moveFile = async (sourcePath: string, targetFolder: string) => {
    const fileName = sourcePath.split("/").at(-1) ?? sourcePath;
    const destinationPath = targetFolder ? `${targetFolder}/${fileName}` : fileName;
    try {
      await rpc.call("movePath", {
        vaultId: activeVaultId,
        from: sourcePath,
        to: destinationPath,
      });
      if (!isCurrentVault(activeVaultId)) return;
      refresh();
      if (filePath === sourcePath) open(destinationPath, true);
      toast.success(
        targetFolder
          ? `Moved ${fileName} to ${targetFolder}`
          : `Moved ${fileName} to the top level`,
      );
    } catch (error) {
      toast.error(
        `Could not move ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {navigationOnly ? (
          <Tree
            data={data}
            selectedPath={filePath}
            onOpen={open}
            onNewNote={newNote}
            onNewFolder={() => setFolderDialogOpen(true)}
            onDeleteFile={(path) => void deleteFile(path)}
            onMoveFile={(sourcePath, targetFolder) => void moveFile(sourcePath, targetFolder)}
            onVaultChange={(value) => {
              navigate.toPluginPanel("docs", {
                subPath: value,
              });
            }}
            onAddVault={() => setVaultDialogOpen(true)}
          />
        ) : filePath && /\.(mdx?|markdown)$/i.test(filePath) ? (
          <NotePane
            key={`${activeVaultId}:${filePath}`}
            vaultId={activeVaultId}
            notePath={filePath}
            onChanged={refresh}
            onRenamed={(next) => {
              refresh();
              open(next, true);
            }}
          />
        ) : filePath && /\.html?$/i.test(filePath) ? (
          <HtmlPane
            key={`${activeVaultId}:${filePath}`}
            vaultId={activeVaultId}
            filePath={filePath}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <p>Select a note or HTML page.</p>
            <Button size="sm" variant="outline" onClick={newNote}>
              New note
            </Button>
          </div>
        )}
      </div>
      {navigationOnly ? (
        <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
          <DialogContent>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void createFolder();
              }}
            >
              <DialogHeader>
                <DialogTitle>New folder</DialogTitle>
                <DialogDescription>
                  Create it {selectedFolder ? `inside ${selectedFolder}` : "at the vault root"}.
                </DialogDescription>
              </DialogHeader>
              <label htmlFor="docs-folder-name" className="grid gap-1.5 text-sm font-medium">
                Folder name
                <Input
                  id="docs-folder-name"
                  value={folderName}
                  onChange={(event) => setFolderName(event.target.value)}
                  placeholder="Projects"
                />
              </label>
              {folderError ? <p className="text-xs text-destructive">{folderError}</p> : null}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setFolderDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!folderName.trim()}>
                  Create folder
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
      {navigationOnly ? (
        <Dialog open={vaultDialogOpen} onOpenChange={setVaultDialogOpen}>
          <DialogContent>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void createVault();
              }}
            >
              <DialogHeader>
                <DialogTitle>Add vault</DialogTitle>
                <DialogDescription>
                  Open a notes folder from this machine or a connected host.
                </DialogDescription>
              </DialogHeader>
              <label htmlFor="docs-vault-name" className="grid gap-1.5 text-sm font-medium">
                Name
                <Input
                  id="docs-vault-name"
                  value={vaultName}
                  onChange={(event) => setVaultName(event.target.value)}
                  placeholder="Personal"
                />
              </label>
              <label htmlFor="docs-vault-path" className="grid gap-1.5 text-sm font-medium">
                Folder path
                <Input
                  id="docs-vault-path"
                  value={vaultRootPath}
                  onChange={(event) => setVaultRootPath(event.target.value)}
                  placeholder="/Users/me/Notes"
                />
              </label>
              <label htmlFor="docs-vault-host" className="grid gap-1.5 text-sm font-medium">
                Host
                <Select value={vaultHostId} onValueChange={setVaultHostId}>
                  <SelectTrigger id="docs-vault-host" aria-label="Vault host">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="primary">Primary host</SelectItem>
                    {data.hosts.map((host) => (
                      <SelectItem key={host.id} value={host.id}>
                        {host.name} · {host.status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {vaultError ? <p className="text-xs text-destructive">{vaultError}</p> : null}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setVaultDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!vaultName.trim() || !vaultRootPath.trim()}>
                  Add vault
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function NotesPanel(props: PluginNavPanelProps) {
  return <NotesWorkspace {...props} navigationOnly={false} />;
}

function NotesNavigationPanel(props: PluginNavPanelProps) {
  return <NotesWorkspace {...props} navigationOnly />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "docs",
    title: "Docs",
    icon: "FileText",
    path: "docs",
    component: NotesPanel,
    fixedTabs: [
      {
        panelId: "docs",
        id: "navigation",
        title: "Navigation",
        icon: "ListView",
        component: NotesNavigationPanel,
        layout: "flush",
      },
    ],
  });
  app.slots.threadPanelAction({
    id: "document",
    title: "Document",
    icon: "FileText",
    component: DocumentPanel,
  });
  app.slots.fileOpener({
    id: "docs",
    title: "Docs",
    extensions: ["md", "mdx", "markdown"],
    component: DocsFileOpener,
  });
  app.slots.messageDirective({ id: "docs", component: DocsDirectiveCard });
});
