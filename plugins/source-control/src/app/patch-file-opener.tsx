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
  type MouseEvent,
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
import { CompactButton } from "./components/ui/button.tsx";
import { FileRowsSkeleton, parsePatch } from "./file-cards.tsx";
import { plural, shortId } from "./format.ts";
import { PHONE, useWidth } from "./page/hooks.ts";
import {
  ColumnContext,
  DiffColumn,
  EAGER_CARDS,
  FileCard,
  TooLargeContext,
  useColumn,
  WrapContext,
} from "./page/files-view.tsx";
import { PatchStore } from "./page/patches.ts";
import { Hint } from "./ui.tsx";

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

/** A body whose bytes aren't UTF-8: decoding would replace them, and two names or lines could read the same. */
export const NOT_UTF8 = Symbol("not UTF-8");

/**
 * The body as text, null once it passes `max` bytes (the cap holds without a
 * content-length), or NOT_UTF8 when its bytes aren't UTF-8.
 */
export async function readCapped(
  response: Response,
  max: number,
  onProgress: () => void = () => {},
): Promise<string | null | typeof NOT_UTF8> {
  const size = response.headers.get("content-length");
  if (size !== null && Number(size) > max) {
    void response.body?.cancel();
    return null;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  if (!response.body) return decodeAll(decoder, new Uint8Array(await response.arrayBuffer()));
  const reader = response.body.getReader();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return decodeAll(decoder, undefined, text);
    onProgress();
    total += value.byteLength;
    if (total > max) {
      void reader.cancel();
      return null;
    }
    try {
      text += decoder.decode(value, { stream: true });
    } catch {
      void reader.cancel();
      return NOT_UTF8;
    }
  }
}

function decodeAll(
  decoder: TextDecoder,
  bytes: Uint8Array | undefined,
  before = "",
): string | typeof NOT_UTF8 {
  try {
    return before + decoder.decode(bytes);
  } catch {
    return NOT_UTF8;
  }
}

type Loaded =
  | { state: "loading" }
  /** `failed` says why the last re-read failed; the diff shown is the last copy read. */
  | { state: "diff"; read: PatchFile; failed: string | null }
  /** BB's preview, with the line saying why; a null reason lets the preview speak (a failed read). */
  | { state: "text"; reason: string | null };

const TOO_LARGE = `This file is over ${MAX_PATCH_BYTES / 1024 / 1024} MB, too large for the diff view.`;
/**
 * A read that has received nothing for this long has stalled: the next poll
 * gives it up and asks again. A slow read still sending its file runs on.
 */
const STALL_MS = 60_000;
const STALLED = "BB sent nothing for a minute.";

/** Why a re-read failed, after "Couldn't re-read:". */
function failure(response: Response | null): string {
  if (response === null) return "the request didn't reach BB.";
  if (response.status === 404) return "the file is no longer there.";
  return `BB answered ${response.status}.`;
}

type Known = {
  url: string;
  text: string | null | typeof NOT_UTF8;
  etag: string | null;
  modified: string | null;
};
type Shown = { url: string | null; value: Loaded };
/** One request owns its abort signal and slow-read notice until it settles or is replaced. */
function beginRead(onSlow: () => void) {
  const controller = new AbortController();
  const slowTimer = setTimeout(onSlow, POLL_MS);
  const clearNotice = () => clearTimeout(slowTimer);
  return {
    signal: controller.signal,
    progressed: Date.now(),
    clearNotice,
    cancel() {
      clearNotice();
      controller.abort();
    },
  };
}

/** How a read's outcome lands: what shows for `url`, and whether to keep retrying. */
function outcomes(
  url: string,
  shown: { current: Shown },
  retrying: { current: boolean },
  setLoaded: (value: Shown) => void,
) {
  const current = () => (shown.current.url === url ? shown.current.value : null);
  const put = (value: Loaded) => {
    shown.current = { url, value };
    setLoaded(shown.current);
  };
  const succeed = () => {
    retrying.current = false;
    const value = current();
    if (value?.state === "diff" && value.failed) put({ ...value, failed: null });
  };
  const fail = (why: string) => {
    const next = afterFailure(current(), why);
    retrying.current = next.retry;
    if (next.value) put(next.value);
  };
  return { current, put, succeed, fail };
}

const validators = (response: Response) => ({
  etag: response.headers.get("etag"),
  modified: response.headers.get("last-modified"),
});

/** A conditional request when the last read left a validator to send. */
function conditional(known: Known | null): Record<string, string> {
  if (known?.etag) return { "If-None-Match": known.etag };
  if (known?.modified) return { "If-Modified-Since": known.modified };
  return {};
}

/** What shows after a failed read, and whether to keep trying; null keeps what shows. */
function afterFailure(
  current: Loaded | null,
  why: string,
): { value: Loaded | null; retry: boolean } {
  if (current?.state === "diff") return { value: { ...current, failed: why }, retry: true };
  if (current?.state === "text" && current.reason !== null) return { value: null, retry: true };
  // Nothing read yet: BB's preview says what went wrong, and offers its own Refresh.
  return { value: { state: "text", reason: null }, retry: false };
}

const NOT_UTF8_REASON =
  "This file isn't UTF-8 text, so the diff view can't be sure which bytes each line or name holds.";

/** What a newly read file shows. */
function shownFor(text: string | null | typeof NOT_UTF8): Loaded {
  if (text === null) return { state: "text", reason: TOO_LARGE };
  if (text === NOT_UTF8) return { state: "text", reason: NOT_UTF8_REASON };
  const read = readPatchFile(text);
  if (!read.ok) return { state: "text", reason: read.reason };
  const undrawable = undrawableFile(read.read);
  return undrawable === null
    ? { state: "diff", read: read.read, failed: null }
    : { state: "text", reason: `The diff view can't draw ${undrawable} as its patch reads.` };
}

const HUNK_COUNTS = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm;

/**
 * The first card Pierre can't draw line for line, or null: each card's patch
 * goes through Pierre's own parser before the diff view accepts the file,
 * and the lines it would draw must be the ones the hunk headers count.
 */
/** Old and new line counts a patch's hunk headers state. */
function hunkCounts(patch: string) {
  let old = 0;
  let next = 0;
  for (const [, oldCount, nextCount] of patch.matchAll(HUNK_COUNTS)) {
    old += oldCount === undefined ? 1 : Number(oldCount);
    next += nextCount === undefined ? 1 : Number(nextCount);
  }
  return { old, next };
}

export function undrawableFile(read: PatchFile): string | null {
  for (const commit of read.commits)
    for (const { file, patch } of commit.files) {
      if (patch.patch === "") continue;
      const drawn = parsePatch(patch.patch);
      const { old, next } = hunkCounts(patch.patch);
      if (
        drawn === null ||
        drawn.deletionLines.length !== old ||
        drawn.additionLines.length !== next
      )
        return file.path;
    }
  return null;
}

/**
 * The file read and parsed, read again when it may have changed: on Refresh,
 * when its tab shows again, when the window regains focus, and every few
 * seconds while showing when the server answers a conditional request. A
 * failed re-read keeps the diff on screen, says why, and tries again.
 */
function usePatchFile(url: string | null) {
  const visible = useTabVisible();
  const [loaded, setLoaded] = useState<Shown>({
    url,
    value: { state: "loading" },
  });
  const shown = useRef(loaded);
  const [refreshing, setRefreshing] = useState(false);
  const last = useRef<Known | null>(null);
  /** A re-read failed while something drew: keep asking until one succeeds. */
  const retrying = useRef(false);
  const inflight = useRef<ReturnType<typeof beginRead> | null>(null);
  /** A re-read has run past a poll while a diff shows: say the copy shown may be old. */
  const [slow, setSlow] = useState(false);

  const load = useCallback(
    async (force: boolean) => {
      if (url === null) return;
      const running = inflight.current;
      // A poll or focus waits for the read already running while it still makes progress.
      const stalled = running !== null && Date.now() - running.progressed >= STALL_MS;
      if (running && !force && !stalled) return;
      running?.cancel();
      const flight = beginRead(() => setSlow(inflight.current === flight));
      inflight.current = flight;
      const progress = () => {
        flight.progressed = Date.now();
      };
      const known = last.current?.url === url ? last.current : null;
      const { current, put, succeed, fail } = outcomes(url, shown, retrying, setLoaded);
      if (stalled) fail(STALLED);
      try {
        const response = await fetch(url, {
          credentials: "same-origin",
          cache: "no-cache",
          headers: conditional(known),
          signal: flight.signal,
        });
        progress();
        if (flight.signal.aborted) return;
        if (response.status === 304) return succeed();
        if (!response.ok) {
          void response.body?.cancel();
          return fail(failure(response));
        }
        const text = await readCapped(response, MAX_PATCH_BYTES, progress);
        if (flight.signal.aborted) return;
        last.current = { url, text, ...validators(response) };
        // Unchanged text keeps the drawn diff, its open cards and its scroll.
        if (text !== null && known?.text === text && current()) return succeed();
        retrying.current = false;
        put(shownFor(text));
      } catch {
        if (!flight.signal.aborted) fail(failure(null));
      } finally {
        flight.clearNotice();
        if (inflight.current === flight) {
          inflight.current = null;
          setRefreshing(false);
          setSlow(false);
        }
      }
    },
    [url],
  );

  useEffect(() => {
    void load(true);
    return () => inflight.current?.cancel();
  }, [load]);

  // Read again as the tab shows again, as the window regains focus, and on a poll while showing.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) void load(false);
    wasVisible.current = visible;
    if (!visible) return;
    const onFocus = () => void load(false);
    window.addEventListener("focus", onFocus);
    const poll = setInterval(() => {
      const known = last.current;
      const cheap = Boolean(known?.etag || known?.modified);
      if (document.visibilityState === "visible" && (cheap || retrying.current)) void load(false);
    }, POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(poll);
    };
  }, [visible, load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    // Ask for the whole file; the same text still keeps the cards as they are.
    if (last.current) last.current = { ...last.current, etag: null, modified: null };
    void load(true);
  }, [load]);

  const value: Loaded =
    url === null
      ? { state: "text", reason: null }
      : loaded.url === url
        ? loaded.value
        : { state: "loading" };
  /** Read again, as a poll would: keeps the validators and leaves a running read alone. */
  const recheck = useCallback(() => void load(false), [load]);
  return { loaded: value, refresh, recheck, refreshing, slow };
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
const TOO_LARGE_FILE = "This file's diff is too large to draw. Open as text to read it.";

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

function TextButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <CompactButton
      size="sm"
      variant="ghost"
      data-testid="sc-patch-file-mode"
      className="shrink-0 max-md:pointer-coarse:min-h-11"
      onClick={onClick}
    >
      {label}
    </CompactButton>
  );
}

function RefreshButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <Hint label="Read the file again">
      <CompactButton
        size="icon-sm"
        variant="ghost"
        aria-label="Refresh file"
        aria-busy={refreshing}
        className="shrink-0 max-md:pointer-coarse:min-h-11 max-md:pointer-coarse:min-w-11"
        onClick={onRefresh}
      >
        <Icon
          name="RotateCcw"
          className={`size-3.5 ${refreshing ? "opacity-50" : ""}`}
          aria-hidden
        />
      </CompactButton>
    </Hint>
  );
}

/**
 * Each commit section's identity: its hash, or its place when it has none, so
 * a file added above its first card keeps the section, and the focus in it.
 */
function sectionKeys(read: PatchFile): string[] {
  const seen = new Map<string, number>();
  return read.commits.map((commit, index) => {
    const base = commit.id ?? `#${index}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return `${count}:${base}`;
  });
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
  // A Map: a file named "toString" or "__proto__" is a key like any other.
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const paths = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const commit of read.commits)
      for (const entry of commit.files) byKey.set(entry.key, entry.file.path);
    return byKey;
  }, [read]);
  const isOpen = (key: string, path: string) => open.get(key) ?? !startsCollapsed(path);
  const toggle = useCallback(
    (key: string) =>
      setOpen((state) =>
        new Map(state).set(key, !(state.get(key) ?? !startsCollapsed(paths.get(key) ?? key))),
      ),
    [paths],
  );
  const sections = useMemo(() => sectionKeys(read), [read]);
  const headed = read.commits.length > 1 || read.commits.some((commit) => commit.subject);
  return (
    <ColumnContext.Provider value={column}>
      <DiffColumn scroller={scroller}>
        <div className="flex min-w-0 flex-col gap-4 px-3 py-3 @3xl:px-6 @3xl:py-4">
          {read.commits.map((commit, index) => (
            <section
              key={sections[index]}
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

/** Says the diff shown may be old: its last re-read failed, or one is still running. */
function StaleNotice({ loaded, slow }: { loaded: Loaded; slow: boolean }) {
  if (loaded.state !== "diff" || !(loaded.failed || slow)) return null;
  return (
    <span className="block text-warning" data-testid="sc-patch-file-stale">
      {loaded.failed
        ? `Couldn't re-read: ${loaded.failed} Showing the last copy read.`
        : "Reading the file again… Showing the last copy read."}
    </span>
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
  const { loaded, refresh, recheck, refreshing, slow } = usePatchFile(url);
  // BB's preview has its own Refresh, which reloads only its text: check the file again with it.
  const onPreviewClick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest("button")) recheck();
  };
  const [asText, setAsText] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // As the Files view: lines wrap where scrolling sideways would hide their ends.
  const width = useWidth(root, true);
  const wrap = width !== null && width < PHONE;

  if (loaded.state === "text")
    return loaded.reason === null ? (
      <div className="h-full min-h-0" onClickCapture={onPreviewClick}>
        <Original />
      </div>
    ) : (
      // BB's preview below has its own Refresh, and the poll brings the diff back once the file reads.
      <div className="flex h-full min-h-0 flex-col" data-testid="sc-patch-file-text">
        <Toolbar>
          <span data-testid="sc-patch-file-notice">Shown as text. {loaded.reason}</span>
        </Toolbar>
        <div className="min-h-0 flex-1" onClickCapture={onPreviewClick}>
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
            {asText ? null : <RefreshButton refreshing={refreshing} onRefresh={refresh} />}
            <TextButton
              label={asText ? "Show diff" : "Open as text"}
              onClick={() => setAsText(!asText)}
            />
          </>
        }
      >
        {asText ? "Showing the patch as text" : read ? summary(read) : "Reading the patch…"}
        <StaleNotice loaded={loaded} slow={slow} />
      </Toolbar>
      <div className="relative min-h-0 flex-1">
        {read ? (
          // Kept mounted, and laid out, behind the text: open cards and scroll survive the switch.
          <div
            className={`absolute inset-0 flex min-h-0 flex-col ${asText ? "invisible" : ""}`}
            inert={asText}
          >
            <WrapContext.Provider value={wrap}>
              <TooLargeContext.Provider value={TOO_LARGE_FILE}>
                <PatchColumn read={read} scroller={scroller} onOpenAsText={() => setAsText(true)} />
              </TooLargeContext.Provider>
            </WrapContext.Provider>
          </div>
        ) : (
          <div className="px-3 py-3">
            <FileRowsSkeleton rows={6} label="Loading the patch…" />
          </div>
        )}
        {asText ? (
          <div
            className="absolute inset-0 bg-background"
            data-testid="sc-patch-file-text"
            onClickCapture={onPreviewClick}
          >
            <Original />
          </div>
        ) : null}
      </div>
    </div>
  );
}
