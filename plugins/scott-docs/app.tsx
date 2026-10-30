import {
  createMarkdownEditor,
  markdownExtensions,
  type MarkdownSession,
} from "@bb-plugins/markdown-editor/engine";
import "./editor.css";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
} from "react";
import "@bb-plugins/markdown-prose/prose.css";
import {
  experimental_useAppPanel,
  definePluginApp,
  experimental_FileLink as FileLink,
  experimental_copyToClipboard,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
  useComposer,
  useRpc,
  useSdk,
  type PluginFileOpenerProps,
  type PluginMessageDirectiveProps,
  type PluginNavPanelProps,
  type ExperimentalLiveFileTarget,
  type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import { DOMParser as ProseMirrorDOMParser, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createProposalDiff, proposalDiffKey } from "./proposal-diff.js";
import {
  contentOf,
  documentSession,
  useDocumentSession,
  type DocumentSession,
  type DocumentSnapshot,
  type DocumentState,
} from "./document-session.js";
import type { Proposal } from "./proposals.js";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { docsRpcContract, errorMessage } from "./contract.js";
import {
  documentHeading,
  isRecord,
  parseMarkdownDocument,
} from "@bb-plugins/markdown-editor/markdown-document";
import { Editor, Node, mergeAttributes } from "@tiptap/core";
import { preparePresortedFileTreeInput } from "@pierre/trees";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import { toast } from "sonner";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import FileAddIcon from "@hugeicons/core-free-icons/FileAddIcon";
import FolderAddIcon from "@hugeicons/core-free-icons/FolderAddIcon";
import HtmlFile01Icon from "@hugeicons/core-free-icons/HtmlFile01Icon";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

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

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function dirname(value: string): string {
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index);
}

function normalizeRelative(base: string, relative: string): string {
  if (!relative.startsWith(".")) return relative.replace(/^\//, "");
  const stack = base ? base.split("/") : [];
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function relativeFrom(base: string, target: string): string {
  const from = base ? base.split("/") : [];
  const to = target.split("/");
  while (from[0] && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return (
    `${from.map(() => "..").join("/")}${from.length && to.length ? "/" : ""}${to.join("/")}` || "."
  );
}

function previewUrl(baseUrl: string, notePath: string, source: string): string {
  if (/^(https?:|data:|blob:|#)/i.test(source)) return source;
  return `${baseUrl}/${encodePath(normalizeRelative(dirname(notePath), source))}`;
}

function displayMarkdown(content: string, baseUrl: string, notePath: string): string {
  const withImages = content.replace(
    /(!\[[^\]]*\]\()([^\s)]+)([^)]*\))/g,
    (_match, start: string, source: string, end: string) =>
      `${start}${previewUrl(baseUrl, notePath, source)}${end}`,
  );
  return withImages.replace(
    /^::html\{src="([^"]+)"(?: height="(\d+)")?\}[ \t]*$/gm,
    (_match, source: string, height: string | undefined) =>
      `<div data-simple-html-embed="true" data-src="${encodeURIComponent(source)}" data-height="${height ?? "360"}"></div>`,
  );
}

function storedMarkdown(content: string, baseUrl: string, notePath: string): string {
  const prefix = `${baseUrl}/`;
  return content.replace(
    /(!\[[^\]]*\]\()([^\s)]+)([^)]*\))/g,
    (_match, start: string, source: string, end: string) => {
      if (!source.startsWith(prefix)) return `${start}${source}${end}`;
      const target = source.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
      const relative = relativeFrom(dirname(notePath), target);
      return `${start}${relative.startsWith(".") ? relative : `./${relative}`}${end}`;
    },
  );
}

interface PreviewContext {
  baseUrl: string;
  notePath: string;
}

interface HtmlEmbedOptions {
  preview: PreviewContext;
}

const HtmlEmbed = Node.create<HtmlEmbedOptions>({
  name: "simpleHtmlEmbed",
  group: "block",
  atom: true,
  isolating: true,
  addOptions() {
    return { preview: { baseUrl: "", notePath: "" } };
  },
  addAttributes() {
    return {
      src: {
        default: "",
        parseHTML: (element) => decodeURIComponent(element.getAttribute("data-src") ?? ""),
        renderHTML: (attributes) => ({
          "data-src": encodeURIComponent(String(attributes.src)),
        }),
      },
      height: {
        default: 360,
        parseHTML: (element) => Number(element.getAttribute("data-height") ?? 360),
        renderHTML: (attributes) => ({
          "data-height": String(attributes.height),
        }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-simple-html-embed="true"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-simple-html-embed": "true" })];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("section");
      dom.className = "simple-html-embed";
      dom.contentEditable = "false";
      const header = document.createElement("div");
      header.className = "simple-html-embed-header";
      header.textContent = `◇ ${String(node.attrs.src)} · sandboxed`;
      const iframe = document.createElement("iframe");
      iframe.title = `Embedded HTML: ${String(node.attrs.src)}`;
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.style.height = `${Math.min(1200, Math.max(120, Number(node.attrs.height) || 360))}px`;
      iframe.src = previewUrl(
        this.options.preview.baseUrl,
        this.options.preview.notePath,
        String(node.attrs.src),
      );
      dom.append(header, iframe);
      return { dom };
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write(value: string): void;
            closeBlock(node: unknown): void;
          },
          node: { attrs: { src: string; height: number } },
        ) {
          state.write(`::html{src="${node.attrs.src}" height="${node.attrs.height}"}`);
          state.closeBlock(node);
        },
      },
    };
  },
});

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

function TiptapEditor(props: {
  previewBaseUrl: string;
  notePath: string;
  onUpload(file: File): Promise<{ markdownPath: string }>;
  onMarkdownChange(markdown: string): void;
  value: string;
  baseMarkdown?: string | null;
  inline?: boolean;
  disabled?: boolean;
  active?: boolean;
}) {
  const {
    previewBaseUrl,
    notePath,
    value,
    baseMarkdown = null,
    inline = false,
    disabled = false,
    active = true,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const baselineRef = useRef<ProseMirrorNode | null>(null);
  const sourceRef = useRef(value);
  const sessionRef = useRef<MarkdownSession | null>(null);
  const previewRef = useRef<PreviewContext>({
    baseUrl: previewBaseUrl,
    notePath,
  });
  const latest = useRef(props);
  latest.current = props;
  const serializeRef = useRef<() => string>(() => "");
  const display = (source: string) =>
    displayMarkdown(source, previewRef.current.baseUrl, previewRef.current.notePath);
  const setBase = (editor: Editor) => {
    if (latest.current.baseMarkdown == null) baselineRef.current = null;
    else {
      const body = parseMarkdownDocument(latest.current.baseMarkdown).body;
      const root = new window.DOMParser().parseFromString(
        editor.storage.markdown.parser.parse(display(body)),
        "text/html",
      ).body;
      baselineRef.current = ProseMirrorDOMParser.fromSchema(editor.schema).parse(root);
    }
    editor.view.dispatch(editor.state.tr.setMeta(proposalDiffKey, { refresh: true }));
  };

  useEffect(() => {
    if (!rootRef.current) return;
    sourceRef.current = latest.current.value;
    let editor: Editor;
    const upload = async (file: File) => {
      if (!file.type.startsWith("image/")) return false;
      const result = await latest.current.onUpload(file);
      editor
        .chain()
        .focus()
        .setImage({
          src: previewUrl(
            previewRef.current.baseUrl,
            previewRef.current.notePath,
            result.markdownPath,
          ),
          alt: file.name,
        })
        .run();
      return true;
    };
    const created = createMarkdownEditor({
      value: sourceRef.current,
      transformIn: display,
      transformOut: (source) =>
        storedMarkdown(source, previewRef.current.baseUrl, previewRef.current.notePath),
      element: rootRef.current,
      extensions: [
        ...markdownExtensions(),
        createProposalDiff({ getBaseDocument: () => baselineRef.current }),
        HtmlEmbed.configure({ preview: previewRef.current }),
      ],
      content: "",
      editable: !latest.current.disabled,
      editorProps: {
        attributes: {
          class: "bb-markdown-prose",
          role: "textbox",
          "aria-label": "Document content",
          "aria-multiline": "true",
        },
        handleKeyDown(view, event) {
          if (!inline || event.key !== "Escape") return false;
          view.dom.blur();
          return true;
        },
        handlePaste(_view, event) {
          const file = [...(event.clipboardData?.files ?? [])].find((candidate) =>
            candidate.type.startsWith("image/"),
          );
          if (!file) return false;
          void upload(file);
          return true;
        },
        handleDrop(_view, event) {
          const file = [...(event.dataTransfer?.files ?? [])].find((candidate) =>
            candidate.type.startsWith("image/"),
          );
          if (!file) return false;
          event.preventDefault();
          void upload(file);
          return true;
        },
      },
    });
    editor = created.editor;
    editorRef.current = editor;
    sessionRef.current = created.session;
    setBase(editor);
    const getMarkdown = () => created.session.getMarkdown();
    serializeRef.current = getMarkdown;
    editor.on("update", () => latest.current.onMarkdownChange(getMarkdown()));
    return () => {
      editor.destroy();
      editorRef.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-deps
  }, [inline]);

  useEffect(() => {
    const editor = editorRef.current;
    const preview = previewRef.current;
    const previewChanged =
      preview.baseUrl !== previewBaseUrl || dirname(preview.notePath) !== dirname(notePath);
    preview.baseUrl = previewBaseUrl;
    preview.notePath = notePath;
    if (!editor) return;
    if (previewChanged || (value !== sourceRef.current && value !== serializeRef.current())) {
      sessionRef.current?.load(value, previewChanged);
    }
    sourceRef.current = value;
    // oxlint-disable-next-line react/exhaustive-deps
  }, [value, notePath, previewBaseUrl]);
  useEffect(() => {
    if (editorRef.current) setBase(editorRef.current);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [baseMarkdown]);
  useEffect(() => {
    editorRef.current?.setEditable(!disabled, false);
  }, [disabled]);
  useEffect(() => {
    if (active && !inline) editorRef.current?.commands.focus("end");
  }, [active, inline]);

  const focusFromWhitespace = (event: ReactMouseEvent<HTMLDivElement>) => {
    const editor = editorRef.current;
    if (!editor || event.button !== 0 || !editor.isEditable) return;
    const content = editor.view.dom;
    if (event.target instanceof window.Node && content.contains(event.target)) return;
    event.preventDefault();
    const rect = content.getBoundingClientRect();
    if (event.clientY >= rect.bottom) {
      editor.commands.focus("end");
      return;
    }
    const position = editor.view.posAtCoords({
      left: Math.min(Math.max(event.clientX, rect.left + 1), rect.right - 1),
      top: Math.min(Math.max(event.clientY, rect.top + 1), rect.bottom - 1),
    });
    if (position) editor.chain().focus().setTextSelection(position.pos).run();
    else editor.commands.focus("end");
  };

  return (
    <div
      ref={rootRef}
      data-inline={inline}
      className="bb-simple-notes-editor min-h-0 flex-1 overflow-y-auto text-sm"
      role="presentation"
      onMouseDown={focusFromWhitespace}
    />
  );
}

const defaultVault = (() => {
  let id: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => id,
    set(next: string) {
      if (id === next) return;
      id = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
})();

function useNotebook(vaultId: string | null) {
  const defaultVaultId = useSyncExternalStore(
    defaultVault.subscribe,
    defaultVault.get,
    defaultVault.get,
  );
  const usesDefault = vaultId === null || vaultId === defaultVaultId;
  const query = useRpcQuery({
    contract: docsRpcContract,
    method: "listNotes",
    input: usesDefault ? {} : { vaultId },
  });
  const loadedVaultId = query.data?.vault.id ?? null;
  useEffect(() => {
    if (usesDefault && loadedVaultId !== null) defaultVault.set(loadedVaultId);
  }, [usesDefault, loadedVaultId]);
  const data =
    query.data && (vaultId === null || query.data.vault.id === vaultId) ? query.data : null;
  return {
    data,
    error: query.error?.message ?? null,
    refresh: () => void query.refetch(),
  };
}

function toSnapshot(document: {
  path: string;
  content: string;
  sha256: string;
  proposal: Proposal | null;
  preview: PreviewLease;
}): DocumentSnapshot {
  return {
    content: document.content,
    sha256: document.sha256,
    proposal: document.proposal,
    previewBaseUrl: document.preview.baseUrl,
    previewPath: document.path,
  };
}

function vaultDocumentSession(vaultId: string, path: string, showsProposals: boolean) {
  return documentSession(
    (current) => JSON.stringify([showsProposals ? "card" : "page", vaultId, current]),
    path,
    { showsProposals, delay: showsProposals ? 500 : 700 },
  );
}

function useVaultDocument(
  vaultId: string,
  path: string,
  { showsProposals, vaultError = null }: { showsProposals: boolean; vaultError?: string | null },
) {
  const session = vaultDocumentSession(vaultId, path, showsProposals);
  const currentPath = useSyncExternalStore(
    session.subscribe,
    () => session.getSnapshot().path,
    () => session.getSnapshot().path,
  );
  const query = useRpcQuery({
    contract: docsRpcContract,
    method: "readDocument",
    input: { vaultId, path: currentPath },
  });
  const save = useRpcMutation({
    contract: docsRpcContract,
    method: "saveDocument",
  });
  const update = useRpcMutation({
    contract: docsRpcContract,
    method: "updateProposal",
  });
  const resolve = useRpcMutation({
    contract: docsRpcContract,
    method: "resolveProposal",
  });
  const snapshot = useMemo(() => (query.data ? toSnapshot(query.data) : undefined), [query.data]);
  const state = useDocumentSession(session, {
    snapshot,
    error: query.error?.message ?? vaultError,
    writer: {
      renamesToTitle: !showsProposals,
      save: (target, content, expectedSha256, renameToTitle) =>
        save.mutate({
          vaultId,
          path: target,
          content,
          expectedSha256,
          renameToTitle,
        }),
      updateProposal: (target, content, expectedVersion) =>
        update.mutate({ vaultId, path: target, content, expectedVersion }),
      resolveProposal: (target, action, expectedVersion) =>
        resolve.mutate({ vaultId, path: target, action, expectedVersion }),
      refetch: query.refetch,
    },
  });
  return { state, session };
}

function DocumentNotices({
  state,
  session,
  onSaveCopy,
}: {
  state: DocumentState;
  session: DocumentSession;
  onSaveCopy?(draft: string): void;
}) {
  if (state.phase === "loading") return null;
  if (state.phase === "loaded" && state.mode === "editing" && state.conflict)
    return (
      <div
        className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-4 py-2 text-xs"
        role="alert"
      >
        <span className="min-w-0 flex-1">
          This document changed elsewhere while you were editing.
        </span>
        <Button size="sm" variant="ghost" onClick={() => void session.keepMine()}>
          Keep mine
        </Button>
        <Button size="sm" variant="ghost" onClick={() => session.useTheirs()}>
          Use theirs
        </Button>
      </div>
    );
  const failure =
    state.phase === "loaded" ? state.error : state.reason === "error" ? state.message : null;
  if (failure !== null)
    return (
      <div
        className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-destructive"
        role="alert"
      >
        <span className="min-w-0 flex-1">{failure}</span>
        <Button size="sm" variant="ghost" onClick={() => void session.retry()}>
          Retry
        </Button>
      </div>
    );
  if (state.phase === "loaded") return null;
  const last = state.last;
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-4 py-2 text-xs"
      role="alert"
    >
      <span className="min-w-0 flex-1">
        {state.reason === "unknown-vault"
          ? state.message
          : last
            ? "This document was moved or deleted elsewhere."
            : "This document was moved or deleted."}
      </span>
      {onSaveCopy && last && state.reason === "missing" ? (
        <Button size="sm" variant="ghost" onClick={() => onSaveCopy(last.draft)}>
          Save a copy
        </Button>
      ) : null}
    </div>
  );
}

function useSaveCopy(vaultId: string, path: string) {
  const createNote = useRpcMutation({
    contract: docsRpcContract,
    method: "createNote",
  });
  return async (draft: string) => {
    const name =
      path
        .split("/")
        .at(-1)
        ?.replace(/\.(md|markdown)$/i, "") ?? "Copy";
    try {
      const created = await createNote.mutate({
        vaultId,
        parent: dirname(path),
        name: `${name} copy`,
        content: draft,
      });
      toast.success(`Saved a copy as ${created.path}`);
      return created.path;
    } catch (error) {
      toast.error(`Could not save a copy: ${errorMessage(error)}`);
      return null;
    }
  };
}

function DocumentSkeleton() {
  return (
    <DelayedLoading>
      <output className="block min-w-0 flex-1 overflow-hidden" aria-label="Loading document">
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
  return (path.split("/").at(-1) ?? path).replace(/\.(md|markdown|html?)$/i, "");
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
    !/\.(md|markdown|html?)$/i.test(path)
  )
    return null;
  return { vaultId, path, title };
}

function DocumentAction({
  label,
  icon,
  disabled = false,
  onClick,
}: {
  label: string;
  icon: string;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40"
          >
            <Icon name={icon} className="size-3" />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function InlineDocument({
  document,
  openInTab,
  panel = false,
}: {
  document: DocumentRef;
  openInTab?(title: string): void;
  panel?: boolean;
}) {
  const { state, session } = useVaultDocument(document.vaultId, document.path, {
    showsProposals: true,
  });
  const saveCopy = useSaveCopy(document.vaultId, state.path);
  const content = contentOf(state);
  const hasContent = content !== null;
  const doc = state.phase === "loaded" ? state : null;
  const busy = doc !== null && doc.mode !== "editing";
  const saving = doc?.mode === "editing" && doc.saving;
  const dirty = doc !== null && doc.dirty;
  const title = (content ? documentHeading(content.draft) : null) ?? document.title;
  const rpc = useRpc<typeof docsRpcContract>();
  const composer = useComposer();
  const navigate = useBbNavigate();
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    const content = contentRef.current;
    if (!openInTab || !content) return;
    const measure = () => setTruncated(content.getBoundingClientRect().height > 400);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [hasContent, openInTab]);
  const proposal = doc === null ? null : doc.base.proposal;
  const sha256 = doc === null ? null : doc.base.sha256;
  const pending = proposal?.status === "pending" ? proposal : null;
  const stale = pending !== null && pending.baseSha256 !== sha256;
  const undo =
    proposal &&
    ((proposal.status === "accepted" && proposal.resolvedSha256 === sha256) ||
      (proposal.status === "rejected" && proposal.baseSha256 === sha256));
  const redo = proposal?.status === "undone" && proposal.baseSha256 === sha256;
  const copy = async (text: string) => {
    if (await experimental_copyToClipboard({ text })) {
      toast.success("Document copied");
    } else {
      toast.error("Could not copy the document");
    }
  };
  const ask = async () => {
    setAsking(true);
    setAskError(null);
    try {
      await session.flush();
      composer.insert(
        [
          "Update ",
          {
            provider: "note",
            id: `${document.vaultId}:${document.path}`,
            label: title,
          },
          " ",
        ],
        { at: "end", block: true },
      );
      composer.focus();
    } catch (error) {
      setAskError(errorMessage(error));
    } finally {
      setAsking(false);
    }
  };
  const baseMetadata = pending ? parseMarkdownDocument(pending.baseContent).frontmatter : "";
  const candidateMetadata = pending && doc ? parseMarkdownDocument(doc.draft).frontmatter : "";
  return (
    <TooltipProvider delayDuration={200}>
      <section
        aria-label={title}
        className={
          panel
            ? "flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
            : "my-2 min-w-0 overflow-hidden rounded-lg border border-border bg-background"
        }
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 font-semibold">Docs</span>
            <span className="truncate opacity-70">{title}</span>
          </div>
          {(busy || saving || asking) && (
            <output className="inline-flex size-5 shrink-0 items-center justify-center">
              <Icon name="Loading" className="size-3 animate-spin" />
              <span className="sr-only">Updating document…</span>
            </output>
          )}
          <div
            className="flex shrink-0 items-center gap-0.5"
            role="toolbar"
            aria-label="Document actions"
          >
            {pending && (
              <>
                <DocumentAction
                  label="Accept"
                  icon="Check"
                  disabled={busy || saving || stale}
                  onClick={() => void session.resolve("accept")}
                />
                <DocumentAction
                  label="Reject"
                  icon="X"
                  disabled={busy}
                  onClick={() => void session.resolve("reject")}
                />
              </>
            )}
            {undo && !dirty && (
              <DocumentAction
                label="Undo"
                icon="ArrowTurnBackward"
                disabled={busy}
                onClick={() => void session.resolve("undo")}
              />
            )}
            {redo && !dirty && (
              <DocumentAction
                label="Redo"
                icon="ArrowTurnForward"
                disabled={busy}
                onClick={() => void session.resolve("redo")}
              />
            )}
            <DocumentAction
              label="Ask for changes"
              icon="MessageSquare"
              disabled={content === null || busy || asking}
              onClick={() => void ask()}
            />
            <DocumentAction
              label="Copy"
              icon="Copy"
              disabled={content === null}
              onClick={() => content && void copy(content.draft)}
            />
            {panel && (
              <DocumentAction
                label="Open in Docs"
                icon="ExternalLink"
                onClick={() =>
                  navigate.toPluginPanel("docs", {
                    subPath: `${document.vaultId}/${document.path}`,
                  })
                }
              />
            )}
            {openInTab && (
              <>
                <span className="mx-1 h-4 border-l border-border" />
                <DocumentAction
                  label="Open in tab"
                  icon="ExternalLink"
                  onClick={() => openInTab(title)}
                />
              </>
            )}
          </div>
        </header>
        <DocumentNotices
          state={state}
          session={session}
          onSaveCopy={(draft) => void saveCopy(draft)}
        />
        {askError && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-destructive" role="alert">
            <span>{askError}</span>
          </div>
        )}
        {stale && (
          <p className="px-4 py-2 text-xs text-muted-foreground">
            This document changed. Ask for an updated proposal before accepting.
          </p>
        )}
        <div
          className={panel ? "relative min-h-0 flex-1 overflow-y-auto" : "relative"}
          style={openInTab ? { maxHeight: 400, overflow: "clip" } : undefined}
        >
          {content === null ? (
            state.phase === "loading" ? (
              <DocumentSkeleton />
            ) : null
          ) : (
            <>
              <div
                ref={contentRef}
                className={panel ? "flex min-h-full min-w-0 flex-col" : "min-w-0"}
              >
                {pending && baseMetadata !== candidateMetadata && (
                  <div className="px-6 pt-4 text-xs">
                    <p className="mb-2 font-medium">Document metadata</p>
                    {baseMetadata && (
                      <pre className="whitespace-pre-wrap bg-diff-removed/10 text-diff-removed">
                        <del>{baseMetadata}</del>
                      </pre>
                    )}
                    {candidateMetadata && (
                      <pre className="whitespace-pre-wrap bg-diff-added/10 text-diff-added">
                        {candidateMetadata}
                      </pre>
                    )}
                  </div>
                )}
                <TiptapEditor
                  value={content.draft}
                  baseMarkdown={pending?.baseContent ?? null}
                  inline
                  disabled={state.phase !== "loaded" || state.mode !== "editing" || truncated}
                  previewBaseUrl={content.base.previewBaseUrl}
                  notePath={state.path}
                  onMarkdownChange={session.edit}
                  onUpload={async (file) => {
                    const result = await rpc.call("uploadAttachment", {
                      vaultId: document.vaultId,
                      notePath: state.path,
                      name: file.name,
                      content: await fileToBase64(file),
                    });
                    return { markdownPath: result.markdownPath };
                  }}
                />
              </div>
              {truncated && openInTab && (
                <button
                  type="button"
                  aria-label={`Open ${title} in tab`}
                  className="absolute inset-0 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => openInTab(title)}
                >
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background via-background/95 to-transparent" />
                </button>
              )}
            </>
          )}
        </div>
      </section>
    </TooltipProvider>
  );
}

function DocsDirectiveCard({ attributes }: PluginMessageDirectiveProps) {
  const panel = experimental_useAppPanel();
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
  const openPreview = (title = document.title) => {
    const opened = panel.openTab({
      tab: {
        id: "document",
        context: { kind: "thread" },
        availability: "action",
      },
      title,
      params: {
        vaultId: document.vaultId,
        path: document.path,
        title,
      },
    });
    if (!opened) openInDocs();
  };
  if (!/\.html?$/i.test(document.path))
    return <InlineDocument document={document} openInTab={openPreview} />;
  return (
    <div className="relative my-3 flex h-11 select-none items-center gap-1 rounded-lg border border-border bg-card px-2 shadow-sm transition-colors hover:bg-state-hover">
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => openPreview()}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <HugeiconsIcon icon={HtmlFile01Icon} className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{document.title}</span>
      </button>
      <Button
        className="relative size-8 shrink-0"
        size="icon"
        variant="ghost"
        aria-label="Open in Docs"
        onClick={openInDocs}
      >
        <HugeiconsIcon icon={ArrowUpRight01Icon} className="size-4" />
      </Button>
    </div>
  );
}

function HtmlPreview({ vaultId, path, title, panel = false }: DocumentRef & { panel?: boolean }) {
  const lease = useRpcQuery({
    contract: docsRpcContract,
    method: "preparePreview",
    input: { vaultId, path },
  });
  if (!lease.data) {
    if (!lease.error) return <DocumentSkeleton />;
    return (
      <div className={`text-sm text-destructive ${panel ? "" : "min-w-0 flex-1 p-6"}`}>
        {lease.error.message}
      </div>
    );
  }
  return (
    <iframe
      className="min-h-0 flex-1 border-0 bg-white"
      sandbox="allow-scripts"
      title={title}
      src={`${lease.data.baseUrl}/${encodePath(path)}`}
    />
  );
}

function DocumentPicker() {
  const [subPath, setSubPath] = useState("");
  const panel = experimental_useAppPanel();
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <p className="text-sm text-muted-foreground">Choose a document to open.</p>
      <NotesWorkspace
        subPath={subPath}
        navigationOnly
        onNavigate={(next) => {
          const [vaultId, ...parts] = next.split("/");
          const filePath = parts.join("/");
          if (vaultId && filePath) {
            const title = (filePath.split("/").pop() ?? filePath).replace(
              /\.(md|markdown|html?)$/i,
              "",
            );
            panel.openTab({
              tab: {
                id: "document",
                context: { kind: "thread" },
                availability: "action",
              },
              title,
              params: { vaultId, path: filePath, title },
            });
          } else setSubPath(next);
        }}
      />
    </div>
  );
}

function DocumentPanel({ params }: ExperimentalThreadActionTabProps) {
  const document = parseDocumentRef(params);
  const navigate = useBbNavigate();
  if (!document) return <DocumentPicker />;
  if (!/\.html?$/i.test(document.path)) return <InlineDocument document={document} panel />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TooltipProvider delayDuration={200}>
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 font-semibold">Docs</span>
            <span className="truncate opacity-70">{document.title}</span>
          </div>
          <DocumentAction
            label="Open in Docs"
            icon="ExternalLink"
            onClick={() =>
              navigate.toPluginPanel("docs", {
                subPath: `${document.vaultId}/${document.path}`,
              })
            }
          />
        </header>
      </TooltipProvider>
      <HtmlPreview {...document} panel />
    </div>
  );
}

function SavedDocumentEditor({
  state,
  session,
  onUpload,
  onSaveCopy,
  errorHint = "",
  active = true,
}: {
  state: DocumentState;
  session: DocumentSession;
  onUpload(file: File): Promise<{ markdownPath: string }>;
  onSaveCopy?(draft: string): void;
  errorHint?: string;
  active?: boolean;
}) {
  const content = contentOf(state);
  if (content === null)
    return state.phase !== "unavailable" ? (
      <DocumentSkeleton />
    ) : state.reason === "error" ? (
      <div className="min-w-0 flex-1 p-6 text-sm text-destructive">
        {state.message}
        {errorHint}
      </div>
    ) : (
      <div className="min-w-0 flex-1">
        <DocumentNotices state={state} session={session} />
      </div>
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DocumentNotices state={state} session={session} onSaveCopy={onSaveCopy} />
      <TiptapEditor
        value={content.draft}
        active={active}
        disabled={state.phase !== "loaded" || state.mode !== "editing"}
        previewBaseUrl={content.base.previewBaseUrl}
        notePath={content.base.previewPath}
        onUpload={onUpload}
        onMarkdownChange={session.edit}
      />
    </div>
  );
}

function NotePane({
  vaultId,
  notePath,
  vaultError,
  active,
  onReady,
  onRenamed,
  onOpen,
}: {
  vaultId: string;
  notePath: string;
  vaultError: string | null;
  active: boolean;
  onReady(): void;
  onRenamed(path: string): void;
  onOpen(path: string): void;
}) {
  const rpc = useRpc<typeof docsRpcContract>();
  const { state, session } = useVaultDocument(vaultId, notePath, {
    showsProposals: false,
    vaultError,
  });
  const saveCopy = useSaveCopy(vaultId, state.path);
  const renamed = state.path !== notePath ? state.path : null;
  const onRenamedRef = useRef(onRenamed);
  useEffect(() => {
    onRenamedRef.current = onRenamed;
  });
  useEffect(() => {
    if (renamed !== null) onRenamedRef.current(renamed);
  }, [renamed]);
  const ready = state.phase !== "loading";
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  });
  useEffect(() => {
    if (ready) onReadyRef.current();
  }, [ready]);
  return (
    <SavedDocumentEditor
      state={state}
      session={session}
      active={active}
      onSaveCopy={(draft) =>
        void saveCopy(draft).then((created) => {
          if (created !== null) onOpen(created);
        })
      }
      onUpload={async (file) => {
        const result = await rpc.call("uploadAttachment", {
          vaultId,
          notePath: state.path,
          name: file.name,
          content: await fileToBase64(file),
        });
        return { markdownPath: result.markdownPath };
      }}
    />
  );
}

const SWITCH_REVEAL_MS = 1_000;

function NoteSwitcher({
  vaultId,
  notePath,
  vaultError,
  onRenamed,
  onOpen,
}: {
  vaultId: string;
  notePath: string;
  vaultError: string | null;
  onRenamed(path: string): void;
  onOpen(path: string): void;
}) {
  const target = vaultDocumentSession(vaultId, notePath, false).id;
  const [shown, setShown] = useState({ vaultId, notePath, id: target });
  const pending = shown.id !== target;
  const reveal = useCallback(
    () => setShown({ vaultId, notePath, id: target }),
    [vaultId, notePath, target],
  );
  useEffect(() => {
    if (!pending) return;
    const timeout = window.setTimeout(reveal, SWITCH_REVEAL_MS);
    return () => window.clearTimeout(timeout);
  }, [pending, reveal]);
  const panes = pending
    ? [shown, { vaultId, notePath, id: target }]
    : [{ vaultId, notePath, id: target }];
  return panes.map((pane) => {
    const visible = pane.id === shown.id;
    return (
      <div
        key={pane.id}
        hidden={!visible}
        className={visible ? "flex min-h-0 min-w-0 flex-1" : undefined}
      >
        <NotePane
          vaultId={pane.vaultId}
          notePath={pane.notePath}
          vaultError={vaultError}
          active={visible}
          onReady={pane.id === target ? reveal : () => undefined}
          onRenamed={onRenamed}
          onOpen={onOpen}
        />
      </div>
    );
  });
}

function DocsFileOpener({ path: filePath, source }: PluginFileOpenerProps) {
  const navigate = useBbNavigate();
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
  const session = documentSession(
    () => JSON.stringify(["opener", openerSource, filePath]),
    filePath,
    { showsProposals: false, delay: 700 },
  );
  const query = useRpcQuery({
    contract: docsRpcContract,
    method: "openFile",
    input: { source: openerSource, path: filePath },
  });
  const openedHostId = query.data?.hostId ?? null;
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
      case "host": {
        const hostId = source.experimental_hostId ?? openedHostId;
        return hostId === null ? null : { kind: source.kind, hostId, path: filePath };
      }
      case "thread-storage":
        return source.threadId === null
          ? null
          : { kind: source.kind, threadId: source.threadId, path: filePath };
    }
  }, [filePath, openedHostId, source]);
  const save = useRpcMutation({
    contract: docsRpcContract,
    method: "saveOpenedFile",
  });
  const snapshot = useMemo<DocumentSnapshot | undefined>(
    () =>
      query.data && {
        content: query.data.file.content,
        sha256: query.data.file.sha256,
        proposal: null,
        previewBaseUrl: query.data.preview.baseUrl,
        previewPath: query.data.previewPath,
      },
    [query.data],
  );
  const state = useDocumentSession(session, {
    snapshot,
    error: query.error?.message ?? null,
    writer: {
      renamesToTitle: false,
      save: async (target, content, expectedSha256) => {
        const result = await save.mutate({
          source: openerSource,
          path: target,
          content,
          expectedSha256,
        });
        if (result.outcome === "conflict") throw new Error("This document changed elsewhere.");
        return { path: target, sha256: result.sha256 };
      },
      refetch: query.refetch,
    },
  });
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
      <SavedDocumentEditor
        state={state}
        session={session}
        errorHint=" — use the tab's Open with menu to choose another viewer."
        onUpload={async () => {
          throw new Error("Add this file to a Docs vault before uploading images");
        }}
      />
    </div>
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
            <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
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
            <HugeiconsIcon icon={Search01Icon} className="size-4" />
          </Button>
          <Button
            className="size-8"
            size="icon"
            variant="ghost"
            aria-label="New note"
            onClick={props.onNewNote}
          >
            <HugeiconsIcon icon={FileAddIcon} className="size-4" />
          </Button>
          <Button
            className="size-8"
            size="icon"
            variant="ghost"
            aria-label="New folder"
            onClick={props.onNewFolder}
          >
            <HugeiconsIcon icon={FolderAddIcon} className="size-4" />
          </Button>
          <span className="min-w-0 flex-1" />
        </>
      ) : null}
    </div>
  );
}

function Tree({
  data,
  refreshError,
  onRefresh,
  selectedPath,
  onOpen,
  onNewNote,
  onNewFolder,
  onDeleteFile,
  onMoveFile,
  onVaultChange,
  onAddVault,
  onBindVault,
}: {
  data: NotesData;
  refreshError: string | null;
  onRefresh(): void;
  selectedPath: string | null;
  onOpen(path: string): void;
  onNewNote(): void;
  onNewFolder(): void;
  onDeleteFile(path: string): void;
  onMoveFile(sourcePath: string, targetFolder: string): void;
  onVaultChange(vaultId: string): void;
  onAddVault(): void;
  onBindVault(hostId: string): void;
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
  // Offer another machine only when this one cannot hold the vault: it is
  // unbound, or its host answered that the folder is missing (host.ts). A
  // sleeping host is not a reason to move the vault elsewhere.
  const wrongHost =
    !data.vault.hostId ||
    (!hostUnavailable && /(Folder not found|Not a folder): /.test(data.error ?? ""));

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
  const treeInput = useMemo(() => preparePresortedFileTreeInput(treePaths), [treePaths]);
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onMoveFileRef = useRef(onMoveFile);
  onMoveFileRef.current = onMoveFile;

  // Docs orders siblings itself (folders first, then entry order). Pierre's `presorted` flag
  // re-checks against its own sort, so hand over prepared input it trusts as-is.
  const { model } = useFileTree({
    preparedInput: treeInput,
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
    model.resetPaths({
      preparedInput: treeInput,
      initialExpandedPaths: directoryPaths,
    });
    const current = selectedPathRef.current;
    if (current && treePaths.includes(current)) {
      for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
      model.getItem(current)?.select();
    }
  }, [directoryPaths, model, treeInput, treePaths]);

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
          onSearchOpenChange={(open) => {
            setSearchOpen(open);
            if (open) onRefresh();
          }}
          onNewNote={onNewNote}
          onNewFolder={onNewFolder}
        />
      </div>
      {refreshError && !data.error ? (
        <output className="p-3 text-xs text-destructive">{refreshError}</output>
      ) : null}
      <nav aria-label="Notes" className="relative flex min-h-0 flex-1 flex-col">
        {data.error ? (
          <div className="grid gap-2 p-3 text-xs">
            <p className="text-destructive">{data.error}</p>
            {wrongHost ? (
              <VaultHostChooser
                key={data.vault.id}
                hosts={data.hosts}
                hostId={data.vault.hostId}
                onBind={onBindVault}
              />
            ) : null}
          </div>
        ) : null}
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
            <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
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

// A vault saved before the server moved, or bound to the wrong machine, shows
// an error instead of an empty tree. Let the user point it at the right host.
function VaultHostChooser({
  hosts,
  hostId,
  onBind,
}: {
  hosts: Host[];
  hostId: string | null;
  onBind(hostId: string): void;
}) {
  const [selected, setSelected] = useState(hostId ?? "");
  return (
    <div className="flex items-center gap-1">
      <Select value={selected} onValueChange={setSelected}>
        <SelectTrigger className="h-8 min-w-0 flex-1" aria-label="Vault machine">
          <SelectValue placeholder="Choose machine" />
        </SelectTrigger>
        <SelectContent>
          {hosts.map((host) => (
            <SelectItem key={host.id} value={host.id}>
              {host.name} · {host.status}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={!selected || selected === hostId}
        onClick={() => onBind(selected)}
      >
        Use machine
      </Button>
    </div>
  );
}

const MDX_PATH = /\.mdx$/i;

function parseRoute(subPath: string): {
  vaultId: string | null;
  filePath: string | null;
} {
  if (!subPath) return { vaultId: null, filePath: null };
  const parts = subPath.split("/").map(decodeURIComponent);
  if (parts.length === 1 && /\.(md|markdown|html?)$/i.test(parts[0] ?? "")) {
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
  onNavigate,
  onBrowseDefault,
}: PluginNavPanelProps & {
  navigationOnly: boolean;
  onNavigate?(subPath: string, replace?: boolean): void;
  onBrowseDefault?(): void;
}) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof docsRpcContract>();
  const createNoteMutation = useRpcMutation({
    contract: docsRpcContract,
    method: "createNote",
  });
  const createFolderMutation = useRpcMutation({
    contract: docsRpcContract,
    method: "createFolder",
  });
  const createVaultMutation = useRpcMutation({
    contract: docsRpcContract,
    method: "createVault",
  });
  const deletePathMutation = useRpcMutation({
    contract: docsRpcContract,
    method: "deletePath",
  });
  const movePathMutation = useRpcMutation({
    contract: docsRpcContract,
    method: "movePath",
  });
  const navigateTo = useCallback(
    (next: string, replace?: boolean) => {
      if (onNavigate) onNavigate(next, replace);
      else
        navigate.toPluginPanel("docs", {
          subPath: next,
          ...(replace === undefined ? {} : { replace }),
        });
    },
    [navigate, onNavigate],
  );
  const route = parseRoute(subPath);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const [vaultName, setVaultName] = useState("");
  const [vaultRootPath, setVaultRootPath] = useState("");
  const [vaultHostId, setVaultHostId] = useState("");
  const [primaryHostId, setPrimaryHostId] = useState<string | null>(null);
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

  const sdk = useSdk();
  const vault = data?.vault;
  const open = useCallback(
    (path: string, replace = false) => {
      if (!activeVaultId || !isCurrentVault(activeVaultId)) return;
      if (!MDX_PATH.test(path) || !vault) {
        navigateTo(`${activeVaultId}/${path}`, replace);
        return;
      }
      // MDX belongs to whichever plugin bb picks as its file opener (Canvas).
      // Only a vault bound to a host lists entries to click.
      if (!vault.hostId) return;
      navigate.experimental_openFilePreview({
        target: {
          kind: "host",
          hostId: vault.hostId,
          path: `${vault.rootPath.replace(/[\\/]$/, "")}/${path}`,
        },
        location: null,
      });
    },
    [activeVaultId, isCurrentVault, navigate, navigateTo, vault],
  );

  // Name the server's own host in the add-vault dialog and preselect it.
  useEffect(() => {
    if (!vaultDialogOpen) return;
    let live = true;
    void (async () => {
      const { primaryHostId: hostId } = await sdk.system.config();
      if (!live) return;
      setPrimaryHostId(hostId);
      setVaultHostId((current) => current || hostId || "");
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [sdk, vaultDialogOpen]);

  const pane =
    !navigationOnly && activeVaultId && filePath && /\.(md|markdown)$/i.test(filePath) ? (
      <NoteSwitcher
        vaultId={activeVaultId}
        notePath={filePath}
        vaultError={error !== null && /unknown vault/i.test(error) ? error : null}
        onRenamed={(next) => open(next, true)}
        onOpen={(next) => open(next)}
      />
    ) : null;

  if (!data || !activeVaultId) {
    if (pane && route.vaultId)
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">{pane}</div>
        </div>
      );
    if (error)
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
          <p className="text-destructive">Could not load vaults: {error}</p>
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
          {onBrowseDefault && error === `Unknown vault: ${route.vaultId}` ? (
            <Button size="sm" variant="outline" onClick={onBrowseDefault}>
              Browse default vault
            </Button>
          ) : null}
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
    void createNoteMutation
      .mutate({
        vaultId: activeVaultId,
        parent: selectedFolder,
        name: "Untitled",
      })
      .then((value) => {
        if (isCurrentVault(activeVaultId)) open(value.path);
      })
      .catch((error: unknown) => {
        toast.error(`Could not create a note: ${errorMessage(error)}`);
      });
  const createFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    setFolderError(null);
    const target = selectedFolder ? `${selectedFolder}/${name}` : name;
    try {
      await createFolderMutation.mutate({
        vaultId: activeVaultId,
        path: target,
      });
      if (!isCurrentVault(activeVaultId)) return;
      setFolderName("");
      setFolderDialogOpen(false);
    } catch (error) {
      setFolderError(errorMessage(error));
    }
  };

  const createVault = async () => {
    const name = vaultName.trim();
    const rootPath = vaultRootPath.trim();
    if (!name || !rootPath || !vaultHostId) return;
    setVaultError(null);
    try {
      const value = await createVaultMutation.mutate({ name, rootPath, hostId: vaultHostId });
      if (!isCurrentVault(activeVaultId)) return;
      setVaultName("");
      setVaultRootPath("");
      setVaultHostId("");
      setVaultDialogOpen(false);
      navigateTo(value.id);
    } catch (error) {
      setVaultError(errorMessage(error));
    }
  };

  const bindVault = async (hostId: string) => {
    try {
      await rpc.call("setVaultHost", { vaultId: activeVaultId, hostId });
      if (isCurrentVault(activeVaultId)) refresh();
    } catch (error) {
      toast.error(`Could not change the vault's machine: ${errorMessage(error)}`);
    }
  };

  const deleteFile = async (path: string) => {
    try {
      await deletePathMutation.mutate({
        vaultId: activeVaultId,
        path,
      });
      if (!isCurrentVault(activeVaultId)) return;
      if (filePath === path) {
        navigateTo(activeVaultId, true);
      }
      toast.success(`Deleted ${path}`);
    } catch (error) {
      toast.error(`Could not delete ${path}: ${errorMessage(error)}`);
    }
  };

  const moveFile = async (sourcePath: string, targetFolder: string) => {
    const fileName = sourcePath.split("/").at(-1) ?? sourcePath;
    const destinationPath = targetFolder ? `${targetFolder}/${fileName}` : fileName;
    try {
      await movePathMutation.mutate({
        vaultId: activeVaultId,
        from: sourcePath,
        to: destinationPath,
      });
      if (!isCurrentVault(activeVaultId)) return;
      if (filePath === sourcePath) open(destinationPath, true);
      toast.success(
        targetFolder
          ? `Moved ${fileName} to ${targetFolder}`
          : `Moved ${fileName} to the top level`,
      );
    } catch (error) {
      toast.error(`Could not move ${fileName}: ${errorMessage(error)}`);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {navigationOnly ? (
          <Tree
            data={data}
            refreshError={error}
            onRefresh={refresh}
            selectedPath={filePath}
            onOpen={open}
            onNewNote={newNote}
            onNewFolder={() => setFolderDialogOpen(true)}
            onDeleteFile={(path) => void deleteFile(path)}
            onMoveFile={(sourcePath, targetFolder) => void moveFile(sourcePath, targetFolder)}
            onVaultChange={(value) => navigateTo(value)}
            onAddVault={() => setVaultDialogOpen(true)}
            onBindVault={(hostId) => void bindVault(hostId)}
          />
        ) : pane ? (
          pane
        ) : filePath && /\.html?$/i.test(filePath) ? (
          <HtmlPreview
            key={`${activeVaultId}:${filePath}`}
            vaultId={activeVaultId}
            path={filePath}
            title={filePath}
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
                  Open a notes folder on one of your connected machines.
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
                  placeholder="Absolute path on that machine"
                />
              </label>
              <label htmlFor="docs-vault-host" className="grid gap-1.5 text-sm font-medium">
                Machine
                <Select value={vaultHostId} onValueChange={setVaultHostId}>
                  <SelectTrigger id="docs-vault-host" aria-label="Vault host">
                    <SelectValue placeholder="Choose machine" />
                  </SelectTrigger>
                  <SelectContent>
                    {data.hosts.map((host) => (
                      <SelectItem key={host.id} value={host.id}>
                        {host.name}
                        {host.id === primaryHostId ? " · bb server" : ""} · {host.status}
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
                <Button
                  type="submit"
                  disabled={!vaultName.trim() || !vaultRootPath.trim() || !vaultHostId}
                >
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

// Only the main panel remembers its location. The sidebar and the document
// picker mount NotesWorkspace too, and neither should move the reader.
const LAST_DOCUMENT_KEY = "bb-plugin-scott-docs:last-document";

function NotesPanel(props: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const { subPath } = props;
  const restoredRef = useRef(false);
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  useEffect(() => {
    try {
      if (subPath) {
        restoredRef.current = false;
        const route = parseRoute(subPath);
        // Choosing a vault is a request to return to its browser next time.
        if (route.vaultId) localStorage.setItem(LAST_DOCUMENT_KEY, subPath);
        else localStorage.removeItem(LAST_DOCUMENT_KEY);
        return;
      }
      if (restoredRef.current) return;
      restoredRef.current = true;
      const saved = localStorage.getItem(LAST_DOCUMENT_KEY);
      if (!saved) return;
      const previous = parseRoute(saved);
      if (
        previous.vaultId &&
        (!previous.filePath || /\.(md|markdown|html?)$/i.test(previous.filePath))
      ) {
        navigateRef.current.toPluginPanel("docs", { subPath: saved, replace: true });
      }
    } catch {
      // Unavailable storage or a malformed saved path leaves the panel browsing.
    }
  }, [subPath]);
  const browseDefault = () => {
    try {
      localStorage.removeItem(LAST_DOCUMENT_KEY);
    } catch {
      // Browsing still works when storage is unavailable.
    }
    navigate.toPluginPanel("docs", { subPath: "", replace: true });
  };
  return <NotesWorkspace {...props} navigationOnly={false} onBrowseDefault={browseDefault} />;
}

function NotesNavigationPanel(props: PluginNavPanelProps) {
  return <NotesWorkspace {...props} navigationOnly />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "docs",
    title: "Docs",
    icon: "scott-docs/plugin",
    path: "docs",
    component: NotesPanel,
  });
  app.slots.experimental_tab({
    context: { kind: "nav-panel", panelId: "docs" },
    availability: "fixed",
    id: "navigation",
    title: "Navigation",
    icon: "FileText",
    component: NotesNavigationPanel,
    layout: "flush",
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "document",
    title: "Document",
    icon: "FileText",
    component: DocumentPanel,
    layout: "flush",
  });
  app.slots.fileOpener({
    id: "docs",
    title: "Docs",
    extensions: ["md", "markdown"],
    component: DocsFileOpener,
  });
  app.slots.messageDirective({ id: "docs", component: DocsDirectiveCard });
});
