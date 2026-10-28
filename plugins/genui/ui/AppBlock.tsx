// The escape hatch for UIs the component catalog cannot express (games,
// simulations, custom visuals): the model writes a complete self-contained
// HTML document in an ```app fence and it runs in a sandboxed iframe with an
// opaque origin and no network, styled by BB's theme passed in as CSS
// variables. While the fence streams, a second frame draws the markup written
// so far without running any of it. The documents and their bootstrap are in
// appDocument.ts; what a frame may post back is checked in appBridge.ts.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { experimental_saveFile, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { processPartialHtml } from "../core/partialHtml";
import {
  blockedNote,
  parseAppMessage,
  readAppStorage,
  saveAppStorage,
  type AppMessage,
  type AppStorageItems,
} from "./appBridge";
import {
  APP_SANDBOX,
  appFileName,
  buildPreviewSrcdoc,
  buildSrcdoc,
  PREVIEW_SANDBOX,
  resolveTheme,
  themeCss,
  type AppTheme,
} from "./appDocument";
import { Frame, useBlockAnswerTarget, type AnswerTarget } from "./LiveUi";
import { usePaneBounds } from "./paneBounds";
import { rememberHeight, storedHeight } from "./reservedHeight";
import { AnswersContext } from "./runtime";
import { FOCUS_RING, InMessageLine, SentLine } from "./components/inputs";
import { useAnimationsOff } from "./components/motion";

const CARD = "rounded-xl border border-border bg-background p-4 sm:px-5";
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 1400;
/** How often the streaming preview redraws; the first markup goes at once. */
const PREVIEW_POST_MS = 300;
/** An app answers one question: its own. */
const QUESTION = "app";
/** The app's one question is the block's first; module-level so the answer hook's `stage` keeps its identity. */
const placeApp = () => 0;

const TOOL_BUTTON = cn(
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground",
  FOCUS_RING,
);

const clampHeight = (height: number) => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(height)));

function readHostTheme(): AppTheme {
  const style = getComputedStyle(document.documentElement);
  return resolveTheme((property) => style.getPropertyValue(property));
}

/**
 * Keeps a frame's theme and motion in step with BB's: a theme switch or the
 * Animations setting reaches the running app without reloading it. The
 * returned `sync` re-sends both once the frame's document has loaded, for a
 * change made while it was loading.
 */
function useHostSync(iframe: RefObject<HTMLIFrameElement | null>, motionOff: boolean): () => void {
  const sentCss = useRef("");
  const motion = useRef(motionOff);
  motion.current = motionOff;

  // Stable: reads only refs, so the observers below subscribe once.
  const postTheme = useCallback(
    (force: boolean) => {
      const css = themeCss(readHostTheme());
      if (!force && css === sentCss.current) return;
      sentCss.current = css;
      iframe.current?.contentWindow?.postMessage({ source: "genui-host", type: "theme", css }, "*");
    },
    [iframe],
  );

  useEffect(() => {
    const onThemeChange = () => postTheme(false);
    const observer = new MutationObserver((records) => {
      const themeAttribute = records.some(
        ({ attributeName }) =>
          attributeName === "class" || attributeName === "style" || attributeName?.startsWith("data-"),
      );
      if (themeAttribute) onThemeChange();
    });
    observer.observe(document.documentElement, { attributes: true });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", onThemeChange);
    return () => {
      observer.disconnect();
      scheme.removeEventListener("change", onThemeChange);
    };
  }, [postTheme]);

  useEffect(() => {
    iframe.current?.contentWindow?.postMessage({ source: "genui-host", type: "motion", off: motionOff }, "*");
  }, [iframe, motionOff]);

  return useCallback(() => {
    postTheme(true);
    iframe.current?.contentWindow?.postMessage({ source: "genui-host", type: "motion", off: motion.current }, "*");
  }, [iframe, postTheme]);
}

export function AppBlock({
  html,
  ready,
  stateKey,
  answers,
  superseded = false,
}: {
  html: string;
  /** The fence is closed: the app runs. Until then the preview draws its markup. */
  ready: boolean;
  /** The block's persistent key: its height, saved storage and answer are kept under it. */
  stateKey: string;
  /** Where `genui.answer` goes; in the gallery nothing persists. */
  answers: AnswerTarget;
  /** A later user message exists in the thread. */
  superseded?: boolean;
}) {
  const [previewed, setPreviewed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const onPreviewContent = useCallback(() => setPreviewed(true), []);
  const onAppLoaded = useCallback(() => setLoaded(true), []);
  // The preview stays over the finished app until its document loads, so the
  // reader never sees an empty frame between the two.
  const previewing = !ready || (previewed && !loaded);
  return (
    <Frame source={html} language="html" diagnostics={[]}>
      <div className="relative">
        {ready ? (
          // Keyed so a changed document starts with a fresh height and no stale error.
          <AppFrame
            key={html}
            html={html}
            stateKey={stateKey}
            target={answers}
            superseded={superseded}
            covered={previewing}
            onLoaded={onAppLoaded}
          />
        ) : null}
        {previewing ? (
          <PreviewFrame key="preview" html={html} stateKey={stateKey} cover={ready} onContent={onPreviewContent} />
        ) : null}
      </div>
    </Frame>
  );
}

/**
 * The markup streamed so far, drawn by a frame that never runs the model's
 * code (appDocument.ts). It keeps "Building app…" until something shows,
 * and remembers its height so the finished app opens at it.
 */
function PreviewFrame({
  html,
  stateKey,
  cover,
  onContent,
}: {
  html: string;
  stateKey: string;
  /** The app is ready and loading under the preview. */
  cover: boolean;
  onContent: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const motionOff = useAnimationsOff();
  const [srcdoc] = useState(() => buildPreviewSrcdoc({ theme: readHostTheme(), motionOff }));
  const sync = useHostSync(iframeRef, motionOff);
  const [height, setHeight] = useState(0);
  const latest = useRef({ html, cover });
  latest.current = { html, cover };
  const posting = useRef<{ loaded: boolean; postedAt: number; timer: number | undefined; sent: string }>({
    loaded: false,
    postedAt: 0,
    timer: undefined,
    sent: "",
  });

  // Processing happens here, at most once per PREVIEW_POST_MS, not on every streamed token.
  const post = useCallback(() => {
    const state = posting.current;
    clearTimeout(state.timer);
    state.timer = undefined;
    state.postedAt = performance.now();
    const { css, body } = processPartialHtml(latest.current.html);
    const sent = `${css}\u0000${body}`;
    if (sent === state.sent) return;
    state.sent = sent;
    iframeRef.current?.contentWindow?.postMessage({ source: "genui-host", type: "preview", css, body }, "*");
  }, []);

  useEffect(() => {
    const state = posting.current;
    if (!state.loaded) return;
    // Covering the app: draw the whole document now, so the hand-over matches.
    if (cover) {
      post();
      return;
    }
    if (state.timer !== undefined) return;
    const wait = state.postedAt + PREVIEW_POST_MS - performance.now();
    if (wait <= 0) post();
    else state.timer = window.setTimeout(post, wait);
  }, [html, cover, post]);
  useEffect(() => () => clearTimeout(posting.current.timer), []);

  useLayoutEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      const message = parseAppMessage(event.data);
      if (message?.type !== "height") return;
      const next = Math.min(MAX_HEIGHT, Math.ceil(message.height));
      setHeight(next);
      if (next === 0) return;
      onContent();
      // Once the app runs under it, the app's own height is the one to keep.
      if (!latest.current.cover) rememberHeight(stateKey, frame.getBoundingClientRect().width, clampHeight(next));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [stateKey, onContent]);

  return (
    <div aria-hidden={cover || undefined} className={cn(CARD, cover && "pointer-events-none absolute inset-0 z-10 overflow-hidden")}>
      <iframe
        ref={iframeRef}
        title="App preview"
        sandbox={PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={srcdoc}
        tabIndex={-1}
        aria-hidden
        onLoad={() => {
          posting.current.loaded = true;
          sync();
          post();
        }}
        className="pointer-events-none block w-full border-0"
        style={{ height }}
      />
      {cover ? null : height > 0 ? (
        <span role="status" className="sr-only">
          Building app…
        </span>
      ) : (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="size-2 animate-pulse rounded-full bg-[var(--color-timeline-accent,var(--primary))]" />
          Building app…
        </div>
      )}
    </div>
  );
}

function AppFrame({
  html,
  stateKey,
  target,
  superseded,
  covered,
  onLoaded,
}: {
  html: string;
  stateKey: string;
  target: AnswerTarget;
  superseded: boolean;
  /** The preview still covers it: hidden until its document loads. */
  covered: boolean;
  onLoaded: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const navigate = useBbNavigate();
  const motionOff = useAnimationsOff();
  const sync = useHostSync(iframeRef, motionOff);
  const answers = useBlockAnswerTarget(target, stateKey, superseded, placeApp);
  // Only a thread's apps keep their storage; the gallery's start fresh.
  const persist = target.kind === "thread";
  const [restored] = useState<AppStorageItems>(() => (persist ? readAppStorage(stateKey) : {}));
  /** The app's localStorage as it last posted it, for the download. */
  const storage = useRef(restored);
  const [srcdoc] = useState(() => buildSrcdoc(html, { theme: readHostTheme(), motionOff, storage: restored }));
  const [height, setHeight] = useState(() => clampHeight(storedHeight(stateKey) ?? MIN_HEIGHT));
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const fullRef = useRef(full);
  fullRef.current = full;
  const bounds = usePaneBounds(dialogRef, full);

  // Remembered at this width (a remount, a reload): open at it.
  useLayoutEffect(() => {
    const width = iframeRef.current?.getBoundingClientRect().width ?? 0;
    const atWidth = storedHeight(stateKey, width);
    if (atWidth !== null) setHeight(clampHeight(atWidth));
  }, [stateKey]);

  // Full screen moves the app into the top layer as a modal dialog: the
  // iframe stays where it is in the DOM (moving it would reload the app),
  // and the top layer escapes any transformed or clipping ancestor. With
  // threads side by side it covers the app's own pane; the backdrop dims the rest.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || typeof dialog.showModal !== "function") return;
    if (full && !dialog.open) dialog.showModal();
    else if (!full && dialog.open) dialog.close();
  }, [full]);

  const handle = useRef<(message: AppMessage, frame: HTMLIFrameElement) => void>(() => undefined);
  handle.current = (message, frame) => {
    switch (message.type) {
      case "height": {
        const next = clampHeight(message.height);
        setHeight(next);
        // Full screen lays the app out at its pane's or the window's width: not its height in the reply.
        if (!fullRef.current) rememberHeight(stateKey, frame.getBoundingClientRect().width, next);
        return;
      }
      case "error":
        setError(message.message);
        return;
      case "storage":
        storage.current = message.items;
        if (persist) saveAppStorage(stateKey, message.items);
        return;
      case "blocked":
        setNote(blockedNote(message.call));
        return;
      case "answer":
        void answers.stage(QUESTION, message.text === null ? null : { text: message.text, selection: true });
        return;
      case "openLink":
        if (!navigate.openUrl(message.url)) toast.error(`Couldn't open ${message.url}`);
        return;
      case "escape":
        setFull(false);
        return;
    }
  };

  // A layout effect so the listener exists before the srcdoc document runs.
  useLayoutEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      const message = parseAppMessage(event.data);
      if (message !== null) handle.current(message, frame);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const download = async () => {
    const file = buildSrcdoc(html, { theme: readHostTheme(), motionOff: false, storage: storage.current, standalone: true });
    await experimental_saveFile({ fileName: appFileName(html), blob: new Blob([file], { type: "text/html" }) });
  };

  const staged = answers.staged.has(QUESTION);
  const sent = answers.sent?.filter((entry) => entry.question === QUESTION).at(-1)?.text ?? null;
  return (
    <AnswersContext value={answers}>
      <dialog
        ref={dialogRef}
        aria-label="App"
        // Closed by Escape with focus outside the app (inside it, the app posts "escape").
        onClose={() => setFull(false)}
        className={cn(
          "group/app relative m-0 block h-auto w-full max-h-none max-w-none text-foreground",
          full ? "fixed inset-0 flex size-full flex-col rounded-none border-0 bg-background p-4 backdrop:bg-black/40" : CARD,
        )}
        style={full && bounds !== null ? { ...bounds, right: "auto", bottom: "auto" } : undefined}
      >
        <iframe
          ref={iframeRef}
          title="App"
          sandbox={APP_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={srcdoc}
          onLoad={() => {
            // A theme or motion change during loading reached the previous document: re-sync.
            sync();
            onLoaded();
          }}
          className={cn("block w-full border-0", full && "min-h-0 flex-1", covered && "invisible")}
          style={full ? undefined : { height }}
        />
        {error === null ? null : (
          <p className="mt-2 truncate text-xs text-destructive/80" title={error}>
            {error}
          </p>
        )}
        {note === null ? null : (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {note}
          </p>
        )}
        {staged ? (
          <div className="mt-2">
            <InMessageLine />
          </div>
        ) : sent === null ? null : (
          <div className="mt-2">
            <SentLine text={sent} />
          </div>
        )}
        <div
          className={cn(
            "absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-background/90 p-0.5 shadow-sm transition-opacity duration-150",
            full ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover/app:opacity-100 [@media(hover:none)]:opacity-100",
          )}
        >
          <button type="button" aria-label="Download as HTML" title="Download as HTML" onClick={download} className={TOOL_BUTTON}>
            <Icon name="Download" aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={full ? "Close full screen" : "Full screen"}
            title={full ? "Close full screen (Esc)" : "Full screen"}
            onClick={() => setFull((shown) => !shown)}
            className={TOOL_BUTTON}
          >
            <Icon name={full ? "X" : "Maximize2"} aria-hidden className="size-3.5" />
          </button>
        </div>
      </dialog>
    </AnswersContext>
  );
}
