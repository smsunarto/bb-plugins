/**
 * Opens `.patch` and `.diff` files as the Review page's Files view draws a
 * Change: one card per file, with its path, status and +/− counts, and
 * Pierre's diff virtualized against the column. A file that holds no diff
 * this can read, or one too large to fetch, shows as BB's text preview;
 * "Open as text" switches to it on demand.
 */
import type { PluginFileOpenerProps, PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import type { FilePatch } from "../core/change.ts";
import { readPatchFile, type PatchFile, type PatchFileCommit } from "../core/patch-file.ts";
import { Button } from "./components/ui/button.tsx";
import { FileRowsSkeleton } from "./file-cards.tsx";
import { plural } from "./format.ts";
import {
  ColumnContext,
  DiffColumn,
  EAGER_CARDS,
  FileCard,
  isOpen,
  useColumn,
  useOpenState,
  WrapContext,
} from "./page/files-view.tsx";
import { PatchStore } from "./page/patches.ts";

/** Larger files show as text: reading them whole into the page would cost more than it shows. */
export const MAX_PATCH_BYTES = 8 * 1024 * 1024;

function encodePath(path: string): string {
  return path.replace(/^\/+/u, "").split("/").map(encodeURIComponent).join("/");
}

/** The file's raw URL on the BB server, as BB's own file openers read it. */
export function patchFileUrl(path: string, source: PluginFileOpenerSource): string | null {
  const file = encodePath(path);
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

type Loaded =
  | { state: "loading" }
  /** Null `read` when the text holds no diff: shown as text. */
  | { state: "ready"; read: PatchFile | null }
  /** Too large, or the request failed: BB's preview shows the file and its own error. */
  | { state: "text" };

function usePatchFile(url: string | null): Loaded {
  const [loaded, setLoaded] = useState<{ url: string | null; value: Loaded }>({
    url,
    value: { state: "loading" },
  });
  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    const settle = (value: Loaded) => {
      if (!controller.signal.aborted) setLoaded({ url, value });
    };
    void (async () => {
      try {
        const response = await fetch(url, {
          credentials: "same-origin",
          signal: controller.signal,
        });
        const size = Number(response.headers.get("content-length") ?? "0");
        if (!response.ok || size > MAX_PATCH_BYTES) {
          // Leave the body unread: BB's preview reads it again, with its own states.
          settle({ state: "text" });
          controller.abort();
          return;
        }
        const text = await response.text();
        if (text.length > MAX_PATCH_BYTES) return settle({ state: "text" });
        settle({ state: "ready", read: readPatchFile(text) });
      } catch {
        settle({ state: "text" });
      }
    })();
    return () => controller.abort();
  }, [url]);
  if (url === null) return { state: "text" };
  return loaded.url === url ? loaded.value : { state: "loading" };
}

/** A patch store already holding every file: cards ask for their patch as the Files view's do. */
function storeOf(commit: PatchFileCommit): PatchStore {
  const byPath = new Map<string, FilePatch>(
    commit.files.map((entry) => [entry.file.path, entry.patch]),
  );
  return new PatchStore(async (paths) => ({
    ok: true,
    value: { files: paths.flatMap((path) => byPath.get(path) ?? []) },
  }));
}

const NOOP = () => {};

/** A phone, not a narrow desktop panel: there the Files view wraps lines rather than scroll sideways. */
const PHONE_QUERY = "(max-width: 767px) and (pointer: coarse)";

function subscribePhone(onChange: () => void): () => void {
  if (typeof matchMedia === "undefined") return NOOP;
  const query = matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const isPhone = () => typeof matchMedia !== "undefined" && matchMedia(PHONE_QUERY).matches;

/** One commit's files, with their own column watch, store and open state. */
function CommitFiles({
  commit,
  scroller,
  firstIndex,
  showHeader,
}: {
  commit: PatchFileCommit;
  scroller: RefObject<HTMLDivElement | null>;
  /** The commit's first card's place among all the file's cards: the first few draw at once. */
  firstIndex: number;
  showHeader: boolean;
}) {
  const column = useColumn(scroller, NOOP);
  const store = useMemo(() => storeOf(commit), [commit]);
  const { openState, toggle } = useOpenState();
  return (
    <ColumnContext.Provider value={column}>
      <section
        aria-label={commit.subject ?? commit.id ?? "Files"}
        className="flex min-w-0 flex-col gap-2"
        data-testid="sc-patch-commit"
      >
        {showHeader ? <CommitHeader commit={commit} /> : null}
        {commit.files.map((entry, index) => (
          <FileCard
            key={entry.file.path}
            eager={firstIndex + index < EAGER_CARDS}
            file={entry.file}
            open={isOpen(openState, entry.file.path)}
            store={store}
            line={null}
            onToggle={toggle}
            review={undefined}
            actions={null}
            head=""
          />
        ))}
      </section>
    </ColumnContext.Provider>
  );
}

function CommitHeader({ commit }: { commit: PatchFileCommit }) {
  const meta = [commit.id?.slice(0, 7), commit.author?.replace(/\s*<[^>]*>$/, ""), commit.date]
    .filter(Boolean)
    .join(" · ");
  return (
    <header className="flex min-w-0 flex-col gap-0.5 px-1 pt-1">
      <h3 className="m-0 min-w-0 text-[13px] leading-5 font-medium break-words text-foreground">
        {commit.subject ?? "Commit"}
      </h3>
      {meta ? (
        <p className="m-0 min-w-0 truncate font-mono text-[11px] leading-4 text-muted-foreground">
          {meta}
        </p>
      ) : null}
    </header>
  );
}

function Toolbar({
  label,
  action,
  onAction,
}: {
  label: ReactNode;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="flex min-h-9 min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-solid border-border-hairline px-3 py-1">
      <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground">
        {label}
      </span>
      <Button
        size="sm"
        variant="ghost"
        data-testid="sc-patch-file-mode"
        className="h-7 shrink-0 px-2 text-[12px] max-md:pointer-coarse:min-h-11"
        onClick={onAction}
      >
        {action}
      </Button>
    </div>
  );
}

/** Each commit with the place of its first card among all the file's cards, which also keys it. */
function sectionsOf(read: PatchFile): { commit: PatchFileCommit; first: number }[] {
  const firsts = read.commits.map((commit) => commit.files.length);
  return read.commits.map((commit, index) => ({
    commit,
    first: firsts.slice(0, index).reduce((sum, count) => sum + count, 0),
  }));
}

function PatchColumn({ read }: { read: PatchFile }) {
  const scroller = useRef<HTMLDivElement>(null);
  const showHeaders = read.commits.length > 1 || read.commits.some((commit) => commit.subject);
  const sections = useMemo(() => sectionsOf(read), [read]);
  const phone = useSyncExternalStore(subscribePhone, isPhone, () => false);
  return (
    <WrapContext.Provider value={phone}>
      <DiffColumn scroller={scroller}>
        <div className="flex min-w-0 flex-col gap-4 px-3 py-3 @3xl:px-6 @3xl:py-4">
          {sections.map(({ commit, first }) => (
            <CommitFiles
              key={first}
              commit={commit}
              scroller={scroller}
              firstIndex={first}
              showHeader={showHeaders}
            />
          ))}
        </div>
      </DiffColumn>
    </WrapContext.Provider>
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
  const loaded = usePatchFile(url);
  const [asText, setAsText] = useState(false);
  const read = loaded.state === "ready" ? loaded.read : null;

  if (loaded.state === "text" || (loaded.state === "ready" && read === null)) return <Original />;
  if (asText)
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="sc-patch-file-text">
        <Toolbar
          label="Showing the patch as text"
          action="Show diff"
          onAction={() => setAsText(false)}
        />
        <div className="min-h-0 flex-1">
          <Original />
        </div>
      </div>
    );
  return (
    <div
      className="@container flex h-full min-h-0 min-w-0 flex-col bg-background"
      data-testid="sc-patch-file"
    >
      <Toolbar
        label={
          read ? (
            <>
              {read.commits.length > 1 ? `${plural(read.commits.length, "commit")} · ` : null}
              {plural(read.files, "file")}{" "}
              <span className="font-mono tabular-nums">
                <span className="text-success-foreground">+{read.additions}</span>{" "}
                <span className="text-destructive-text">−{read.deletions}</span>
              </span>
            </>
          ) : (
            "Reading the patch…"
          )
        }
        action="Open as text"
        onAction={() => setAsText(true)}
      />
      {read ? (
        <PatchColumn read={read} />
      ) : (
        <div className="min-h-0 flex-1 px-3 py-3">
          <FileRowsSkeleton rows={6} label="Loading the patch…" />
        </div>
      )}
    </div>
  );
}
