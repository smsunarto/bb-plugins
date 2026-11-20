/**
 * Opens `.patch` and `.diff` files as the Review page's Files view draws a
 * Change: one card per file, with its path, status and +/− counts, and
 * Pierre's diff virtualized against the column. The diff view shows only
 * what it can show faithfully: a file the parser rejects, or one too large
 * to read, shows as BB's text preview under a line saying why. "Open as
 * text" switches to that preview on demand and keeps the diff view's place.
 */
import {
  experimental_Icon as Icon,
  experimental_useTabVisible as useTabVisible,
  type PluginFileOpenerProps,
  type PluginFileOpenerSource,
} from "@get-bb/plugin-sdk/app";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { startsCollapsed } from "../core/review.ts";
import {
  readPatchFile,
  type PatchFile,
  type PatchFileCommit,
  type PatchFileEntry,
} from "../core/patch-file.ts";
import { Button } from "./components/ui/button.tsx";
import { FileRowsSkeleton } from "./file-cards.tsx";
import { plural, shortId } from "./format.ts";
import { PHONE, useWidth } from "./page/hooks.ts";
import {
  ColumnContext,
  DiffColumn,
  EAGER_CARDS,
  FileCard,
  useColumn,
  WrapContext,
} from "./page/files-view.tsx";
import { PatchStore } from "./page/patches.ts";

/** Larger files show as text: reading them whole into the page would cost more than it shows. */
export const MAX_PATCH_BYTES = 8 * 1024 * 1024;
/** How often a showing tab asks whether its file changed, when the server can answer cheaply. */
const POLL_MS = 5000;

/** The file's raw URL on the BB server, as BB's own file openers read it; null for a path with `.` or `..`. */
export function patchFileUrl(path: string, source: PluginFileOpenerSource): string | null {
  const segments = path.replace(/^\/+/u, "").split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  const file = segments.map(encodeURIComponent).join("/");
  switch (source.kind) {
    case "workspace":
      if (source.environmentId !== null)
        return `/api/v1/environments/${encodeURIComponent(source.environmentId)}/files/${file}`;
      if (source.projectId !== null) {
        const project = `/api/v1/projects/${encodeURIComponent(source.projectId)}`;
        return source.experimental_hostId
          ? `${project}/hosts/${encodeURIComponent(source.experimental_hostId)}/files/${file}`
          : `${project}/files/${file}`;
      }
      return null;
    case "host":
      return source.threadId === null
        ? null
        : `/api/v1/threads/${encodeURIComponent(source.threadId)}/host-files/${file}`;
    case "thread-storage":
      return source.threadId === null
        ? null
        : `/api/v1/threads/${encodeURIComponent(source.threadId)}/thread-storage/files/${file}`;
  }
}

/** The body as text, or null once it passes `max` bytes: the cap holds without a content-length. */
export async function readCapped(response: Response, max: number): Promise<string | null> {
  const size = response.headers.get("content-length");
  if (size !== null && Number(size) > max) {
    void response.body?.cancel();
    return null;
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > max) {
      void reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

type Loaded =
  | { state: "loading" }
  | { state: "diff"; read: PatchFile }
  /** BB's preview, with the line saying why; a null reason lets the preview speak (a failed read). */
  | { state: "text"; reason: string | null };

const TOO_LARGE = `This file is over ${MAX_PATCH_BYTES / 1024 / 1024} MB, too large for the diff view.`;

/**
 * The file read and parsed, read again when it may have changed: on Refresh,
 * when its tab shows again, when the window regains focus, and every few
 * seconds while showing when the server answers a conditional request.
 */
function usePatchFile(url: string | null) {
  const visible = useTabVisible();
  const [loaded, setLoaded] = useState<{ url: string | null; value: Loaded }>({
    url,
    value: { state: "loading" },
  });
  const [refreshing, setRefreshing] = useState(false);
  const last = useRef<{
    url: string;
    text: string | null;
    etag: string | null;
    modified: string | null;
  }>(null);
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (url === null) return;
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    const known = last.current?.url === url ? last.current : null;
    const headers: Record<string, string> = {};
    if (known?.etag) headers["If-None-Match"] = known.etag;
    else if (known?.modified) headers["If-Modified-Since"] = known.modified;
    const settle = (value: Loaded, text: string | null, response: Response | null) => {
      if (controller.signal.aborted) return;
      last.current = {
        url,
        text,
        etag: response?.headers.get("etag") ?? null,
        modified: response?.headers.get("last-modified") ?? null,
      };
      setLoaded({ url, value });
    };
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-cache",
        headers,
        signal: controller.signal,
      });
      if (response.status === 304) return;
      if (!response.ok) return settle({ state: "text", reason: null }, null, response);
      const text = await readCapped(response, MAX_PATCH_BYTES);
      // Unchanged text keeps the drawn diff, its open cards and its scroll.
      if (text !== null && known?.text === text) return;
      if (text === null) return settle({ state: "text", reason: TOO_LARGE }, null, response);
      const read = readPatchFile(text);
      settle(
        read.ok ? { state: "diff", read: read.read } : { state: "text", reason: read.reason },
        text,
        response,
      );
    } catch {
      if (!controller.signal.aborted) settle({ state: "text", reason: null }, null, null);
    } finally {
      if (inflight.current === controller) {
        inflight.current = null;
        setRefreshing(false);
      }
    }
  }, [url]);

  useEffect(() => {
    void load();
    return () => inflight.current?.abort();
  }, [load]);

  // Read again as the tab shows again, as the window regains focus, and on a poll while showing.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) void load();
    wasVisible.current = visible;
    if (!visible) return;
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const poll = setInterval(() => {
      const known = last.current;
      if (document.visibilityState === "visible" && (known?.etag || known?.modified)) void load();
    }, POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(poll);
    };
  }, [visible, load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    last.current = null;
    void load();
  }, [load]);

  const value: Loaded =
    url === null
      ? { state: "text", reason: null }
      : loaded.url === url
        ? loaded.value
        : { state: "loading" };
  return { loaded: value, refresh, refreshing };
}

/** A patch store already holding every file, keyed by entry: a path may show twice. */
function storeOf(read: PatchFile): PatchStore {
  const byKey = new Map<string, PatchFileEntry>();
  for (const commit of read.commits) for (const entry of commit.files) byKey.set(entry.key, entry);
  return new PatchStore(async (keys) => ({
    ok: true,
    value: {
      files: keys.flatMap((key) => {
        const entry = byKey.get(key);
        // The store files a patch under its path; the key stands in for it.
        return entry ? [{ ...entry.patch, path: key }] : [];
      }),
    },
  }));
}

const NOOP = () => {};

function CommitHeader({ commit }: { commit: PatchFileCommit }) {
  const meta = [commit.id ? shortId(commit.id) : null, commit.authorName, commit.date]
    .filter(Boolean)
    .join(" · ");
  return (
    <header className="flex min-w-0 flex-col gap-0.5 px-1 pt-1">
      <h3 className="m-0 min-w-0 text-[13px] leading-5 font-medium break-words text-foreground">
        {commit.subject ?? "Commit"}
      </h3>
      {meta ? (
        <p className="m-0 min-w-0 font-mono text-[11px] leading-4 break-words text-muted-foreground">
          {meta}
        </p>
      ) : null}
    </header>
  );
}

function Toolbar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-9 min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-solid border-border-hairline px-3 py-1">
      <span className="min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">{children}</span>
      {actions}
    </div>
  );
}

const TOOL = "h-7 shrink-0 px-2 text-[12px] max-md:pointer-coarse:min-h-11";

function TextButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      data-testid="sc-patch-file-mode"
      className={TOOL}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

function RefreshButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={refreshing ? "Refreshing file" : "Refresh file"}
      disabled={refreshing}
      className={`${TOOL} w-7 max-md:pointer-coarse:min-w-11`}
      onClick={onRefresh}
    >
      <Icon name="RotateCcw" className="size-3.5" aria-hidden />
    </Button>
  );
}

/** Each card's place among all of them, keyed by entry, so the first few draw at once. */
function placesOf(read: PatchFile): Map<string, number> {
  const places = new Map<string, number>();
  for (const commit of read.commits)
    for (const entry of commit.files) places.set(entry.key, places.size);
  return places;
}

function PatchColumn({
  read,
  scroller,
  onOpenAsText,
}: {
  read: PatchFile;
  scroller: RefObject<HTMLDivElement | null>;
  onOpenAsText: () => void;
}) {
  const column = useColumn(scroller, NOOP);
  const store = useMemo(() => storeOf(read), [read]);
  const places = useMemo(() => placesOf(read), [read]);
  const [open, setOpen] = useState<Readonly<Record<string, boolean>>>({});
  const paths = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const commit of read.commits)
      for (const entry of commit.files) byKey.set(entry.key, entry.file.path);
    return byKey;
  }, [read]);
  const isOpen = (key: string, path: string) => open[key] ?? !startsCollapsed(path);
  const toggle = useCallback(
    (key: string) =>
      setOpen((state) => ({
        ...state,
        [key]: !(state[key] ?? !startsCollapsed(paths.get(key) ?? key)),
      })),
    [paths],
  );
  const headed = read.commits.length > 1 || read.commits.some((commit) => commit.subject);
  return (
    <ColumnContext.Provider value={column}>
      <DiffColumn scroller={scroller}>
        <div className="flex min-w-0 flex-col gap-4 px-3 py-3 @3xl:px-6 @3xl:py-4">
          {read.commits.map((commit) => (
            <section
              key={commit.files[0]!.key}
              aria-label={commit.subject ?? commit.id ?? "Files"}
              className="flex min-w-0 flex-col gap-2"
              data-testid="sc-patch-commit"
            >
              {headed ? <CommitHeader commit={commit} /> : null}
              {commit.files.map((entry) => (
                <FileCard
                  key={entry.key}
                  id={entry.key}
                  eager={places.get(entry.key)! < EAGER_CARDS}
                  file={entry.file}
                  open={isOpen(entry.key, entry.file.path)}
                  store={store}
                  line={null}
                  onToggle={toggle}
                  review={undefined}
                  actions={null}
                  head=""
                />
              ))}
            </section>
          ))}
          {read.omitted > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-[12px] leading-4 text-muted-foreground">
              <span>{plural(read.omitted, "more file")} not drawn.</span>
              <TextButton label="Open as text" onClick={onOpenAsText} />
            </div>
          ) : null}
        </div>
      </DiffColumn>
    </ColumnContext.Provider>
  );
}

function summary(read: PatchFile): ReactNode {
  return (
    <>
      {read.commits.length > 1 ? `${plural(read.commits.length, "commit")} · ` : null}
      {plural(read.files + read.omitted, "file")}{" "}
      <span className="font-mono tabular-nums">
        <span className="text-success-foreground">+{read.additions}</span>{" "}
        <span className="text-destructive-text">−{read.deletions}</span>
      </span>
    </>
  );
}

export function PatchFileOpener({ path, source, Original }: PluginFileOpenerProps) {
  const url = useMemo(
    () => patchFileUrl(path, source),
    // oxlint-disable-next-line react/exhaustive-deps -- the source object is new on each render
    [
      path,
      source.kind,
      source.threadId,
      source.environmentId,
      source.projectId,
      source.experimental_hostId,
    ],
  );
  const { loaded, refresh, refreshing } = usePatchFile(url);
  const [asText, setAsText] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // As the Files view: lines wrap where scrolling sideways would hide their ends.
  const width = useWidth(root, true);
  const wrap = width !== null && width < PHONE;

  if (loaded.state === "text")
    return loaded.reason === null ? (
      <Original />
    ) : (
      <div className="flex h-full min-h-0 flex-col" data-testid="sc-patch-file-text">
        <Toolbar actions={<RefreshButton refreshing={refreshing} onRefresh={refresh} />}>
          <span data-testid="sc-patch-file-notice">Shown as text. {loaded.reason}</span>
        </Toolbar>
        <div className="min-h-0 flex-1">
          <Original />
        </div>
      </div>
    );

  const read = loaded.state === "diff" ? loaded.read : null;
  return (
    <div
      ref={root}
      className="@container flex h-full min-h-0 min-w-0 flex-col bg-background"
      data-testid="sc-patch-file"
    >
      <Toolbar
        actions={
          <>
            <RefreshButton refreshing={refreshing} onRefresh={refresh} />
            <TextButton
              label={asText ? "Show diff" : "Open as text"}
              onClick={() => setAsText(!asText)}
            />
          </>
        }
      >
        {asText ? "Showing the patch as text" : read ? summary(read) : "Reading the patch…"}
      </Toolbar>
      <div className="relative min-h-0 flex-1">
        {read ? (
          // Kept mounted, and laid out, behind the text: open cards and scroll survive the switch.
          <div
            className={`absolute inset-0 flex min-h-0 flex-col ${asText ? "invisible" : ""}`}
            inert={asText}
          >
            <WrapContext.Provider value={wrap}>
              <PatchColumn read={read} scroller={scroller} onOpenAsText={() => setAsText(true)} />
            </WrapContext.Provider>
          </div>
        ) : (
          <div className="px-3 py-3">
            <FileRowsSkeleton rows={6} label="Loading the patch…" />
          </div>
        )}
        {asText ? (
          <div className="absolute inset-0 bg-background" data-testid="sc-patch-file-text">
            <Original />
          </div>
        ) : null}
      </div>
    </div>
  );
}
