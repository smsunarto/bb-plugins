// Renders a compiled spec and re-evaluates it locally on every state change
// (no model round trip). Shared by fenced ```ui blocks and stored ::ui UIs;
// each caller supplies where answers go and how file links reach its thread.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { collectLoads, dataKey, evaluate, imageSearches, initialState, toMarkdownWithImages, wikiPhotos, type LoadedData, type Program } from "../core";
import { answersText } from "../core/answers";
import type { Action, Diagnostic, Value } from "../core/types";
import { GALLERY_SHEET, sheetFor, useBlockAnswers, type Selection } from "./answerSheet";
import {
  DiagnosticList,
  exampleTitle,
  GalleryFooter,
  ReplySource,
  type GalleryExample,
  type SourceFile,
  type SourceLanguage,
} from "./FrameFooter";
import { RenderNodes } from "./render";
import { useReservedHeight } from "./reservedHeight";
import { AnswersContext, UiRuntimeContext, type Answers, type UiRuntime } from "./runtime";
import { openableLink } from "./components/action-logic";
import { HintProvider } from "./components/inputs";
import { EntranceContext, newStreamCadence, trackStream, useMotionScope } from "./components/motion";
import { foundImages, foundWikiPhotos } from "./webLookups";

/** Blocks mounted in this page, so a remount (BB's timeline while scrolling) doesn't replay entrances. */
const MOUNTED = new Set<string>();
/** Long enough to cover the remount's first commit, short enough for the user's next action to animate. */
const REMOUNT_QUIET_MS = 300;
/** Where a question that is not on screen sorts within its block. */
const UNPLACED = Number.MAX_SAFE_INTEGER;

/**
 * Where a block's answers go. In a thread they are staged into the thread's
 * composer (ui/answerSheet.ts), and `send` posts one at once only when the
 * thread has no composer on screen. The gallery shows what it would stage.
 */
export type AnswerTarget =
  | {
      readonly kind: "thread";
      readonly threadId: string;
      /** The assistant message holding the block. */
      readonly messageId: string;
      /** The block's index among the message's ```ui blocks. */
      readonly fence: number;
      /** The message's index in the thread, once known (reply order of the answers). */
      readonly reply: number | null;
      send(text: string): Promise<void>;
    }
  | { readonly kind: "gallery" };

/** Values the user changed earlier for this UI, from localStorage. */
function readStoredValues(storageKey: string): Record<string, Value> {
  try {
    const raw = localStorage.getItem(storageKey);
    const saved: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return {};
    // fromEntries defines own properties, so a `__proto__` state name stays data.
    return Object.fromEntries(Object.entries(saved as Record<string, Value>));
  } catch {
    return {};
  }
}

export function LiveUi({
  program,
  compileDiagnostics,
  source,
  stateKey,
  data,
  answers: target,
  openFile,
  loadImage,
  readText,
  loadAudio,
  loadAsset,
  superseded = false,
  threadId,
  blockKey,
  gallery,
  streaming = false,
}: {
  program: Program;
  compileDiagnostics: readonly Diagnostic[];
  source: string;
  stateKey: string;
  /** Files the spec reads with Load and Snippet, keyed by `dataKey`. */
  data?: ReadonlyMap<string, LoadedData>;
  answers: AnswerTarget;
  openFile: UiRuntime["openFile"];
  loadImage: UiRuntime["loadImage"];
  readText: UiRuntime["readText"];
  loadAudio: UiRuntime["loadAudio"];
  loadAsset: UiRuntime["loadAsset"];
  /**
   * A later user message exists in the thread (see UiRuntime.superseded);
   * null while that isn't known yet, when the block remembers no height.
   */
  superseded?: boolean | null;
  threadId: UiRuntime["threadId"];
  blockKey: UiRuntime["blockKey"];
  /** Set on the gallery page: which example this is (see Frame). */
  gallery?: GalleryExample;
  /** The reply is still writing this block: what mounts fades at the stream's pace (motion.ts). */
  streaming?: boolean;
}) {
  // State is the program's initial values overlaid with what the user changed.
  // Keeping the two apart lets a still-streaming program add state variables
  // without resetting the ones the user already moved.
  const initial = useMemo(() => initialState(program, data), [program, data]);
  const [changed, setChanged] = useState(() => readStoredValues(stateKey));
  const state = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(initial).map(([name, value]) => [
          name,
          Object.hasOwn(changed, name) ? changed[name] : value,
        ]),
      ),
    [initial, changed],
  );
  const restored = useRef(changed);
  useEffect(() => {
    if (changed === restored.current) return;
    try {
      localStorage.setItem(stateKey, JSON.stringify(changed));
    } catch {
      // Storage full or unavailable: the UI keeps working, it just won't persist.
    }
  }, [stateKey, changed]);

  const navigate = useBbNavigate();
  const setValue = useCallback(
    (name: string, value: Value) => {
      if (Object.hasOwn(initial, name)) setChanged((previous) => ({ ...previous, [name]: value }));
    },
    [initial],
  );

  const runAction = useCallback(
    async (action: Action) => {
      switch (action.type) {
        case "set":
          setValue(action.name, action.value);
          return;
        case "send":
          // An answer: the Button or List row holding it stages it.
          return;
        case "openUrl": {
          // The same check as the hint's, so the hint never names a link this refuses.
          const url = openableLink(action.url);
          if (url === null) throw new Error(`Only http and https links can be opened: ${action.url}`);
          if (!navigate.openUrl(url.href)) throw new Error(`Couldn't open ${url.href}`);
          return;
        }
        case "copy":
          await navigator.clipboard.writeText(action.text);
          toast.success("Copied");
          return;
      }
    },
    [navigate, setValue],
  );

  // Pictures still being read: the block keeps its remembered height until they arrive.
  const [holds, setHolds] = useState(0);
  const holdHeight = useCallback(() => {
    setHolds((count) => count + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      setHolds((count) => count - 1);
    };
  }, []);

  const runtime = useMemo<UiRuntime>(
    () => ({
      setValue,
      openFile,
      loadImage,
      holdHeight,
      readText,
      loadAudio,
      loadAsset,
      superseded: superseded === true,
      threadId,
      blockKey,
      async run(actions) {
        try {
          for (const action of actions) await runAction(action);
        } catch (cause) {
          toast.error(cause instanceof Error ? cause.message : String(cause));
        }
      },
    }),
    [setValue, openFile, loadImage, holdHeight, readText, loadAudio, loadAsset, superseded, threadId, blockKey, runAction],
  );

  const blockRoot = useRef<HTMLDivElement | null>(null);
  // A question's place in the block: document order of the controls on screen.
  const place = useCallback((question: string) => {
    const placed = [...(blockRoot.current?.querySelectorAll("[data-genui-question]") ?? [])].findIndex(
      (element) => element.getAttribute("data-genui-question") === question,
    );
    return placed === -1 ? UNPLACED : placed;
  }, []);
  const answers = useBlockAnswerTarget(target, stateKey, superseded === true, place);

  const { roots, diagnostics } = useMemo(() => evaluate(program, state, data), [program, state, data]);
  // Memoized elements let React skip the tree when only a parent re-renders.
  const tree = useMemo(() => <RenderNodes nodes={roots} isolate />, [roots]);
  // Built only when the user copies: the block as it reads now, with the photos
  // its searches already found on this page (Project components, which need
  // BB's answer, name themselves instead).
  const markdown = useCallback(() => toMarkdownWithImages(roots, foundImages(imageSearches(roots)), foundWikiPhotos(wikiPhotos(roots))), [roots]);
  // The gallery reads files from its own folder, so they're listed under gallery/.
  const inGallery = gallery !== undefined;
  const files = useMemo(
    () =>
      collectLoads(program).map((request): SourceFile => {
        const loaded = data?.get(dataKey(request));
        return {
          path: inGallery && !request.path.startsWith("/") ? `gallery/${request.path}` : request.path,
          kind: request.raw ? "Snippet" : "Load",
          status: data !== undefined && loaded === undefined ? "reading" : loaded === undefined || loaded.ok ? "read" : { error: loaded.error },
        };
      }),
    [program, data, inGallery],
  );
  const { content, minHeight } = useReservedHeight(
    stateKey,
    holds > 0 || files.some((file) => file.status === "reading"),
    superseded === null,
  );
  const [entrance] = useState(() => {
    const remount = MOUNTED.has(stateKey);
    MOUNTED.add(stateKey);
    return { quietUntil: remount ? performance.now() + REMOUNT_QUIET_MS : 0, stream: newStreamCadence() };
  });
  // During render, before the children that mount with this source run their entrances.
  const tracked = useRef<{ source: string; streaming: boolean } | null>(null);
  if (tracked.current?.source !== source || tracked.current.streaming !== streaming) {
    tracked.current = { source, streaming };
    trackStream(entrance.stream, streaming, performance.now());
  }

  const preview = answers.target === "gallery" ? answersText([...answers.staged.values()]) : null;
  return (
    <UiRuntimeContext value={runtime}>
      <AnswersContext value={answers}>
        <EntranceContext value={entrance}>
          <HintProvider>
            <Frame source={source} diagnostics={[...compileDiagnostics, ...diagnostics]} files={files} gallery={gallery} markdown={markdown}>
              {/* Holds the height this block last settled at while what it reads arrives (reservedHeight.ts). */}
              <div ref={blockRoot} style={minHeight === undefined ? undefined : { minHeight }}>
                <div ref={content} className="flex flex-col gap-3">
                  {tree}
                </div>
              </div>
              {preview === null ? null : <AnswersPreview text={preview} />}
            </Frame>
          </HintProvider>
        </EntranceContext>
      </AnswersContext>
    </UiRuntimeContext>
  );
}

/**
 * A block's questions on its thread's answer sheet (ui/answerSheet.ts),
 * for ```ui blocks and apps alike: a pick is staged into the composer's
 * draft, sent at once only when the thread has no composer on screen, and
 * shown as a preview in the gallery. `position` places a question within
 * its block.
 */
export function useBlockAnswerTarget(
  target: AnswerTarget,
  stateKey: string,
  superseded: boolean,
  position: (question: string) => number,
): Answers {
  const sheet = target.kind === "thread" ? sheetFor(target.threadId) : GALLERY_SHEET;
  const block = useBlockAnswers(sheet, stateKey);
  const mode: Answers["target"] = target.kind === "gallery" ? "gallery" : block.composer ? "composer" : "direct";
  // A later user message after a draft emptied with this block's answers in it: they were sent.
  useEffect(() => {
    if (superseded) sheet.supersede(stateKey);
  }, [superseded, sheet, stateKey, block]);
  const stage = useCallback(
    async (question: string, answer: { readonly text: string; readonly selection: Selection } | null) => {
      if (answer === null) {
        sheet.withdraw(stateKey, question);
        return;
      }
      if (mode === "direct" && target.kind === "thread") {
        // No composer for the thread: the pick is the user's message, as before answers were staged.
        try {
          await target.send(answer.text);
          sheet.markSent(stateKey, question, answer.text);
        } catch (cause) {
          toast.error(cause instanceof Error ? cause.message : String(cause));
        }
        return;
      }
      sheet.stage({
        block: stateKey,
        question,
        message: target.kind === "thread" ? target.messageId : stateKey,
        reply: target.kind === "thread" ? target.reply : null,
        fence: target.kind === "thread" ? target.fence : 0,
        position: position(question),
        text: answer.text,
        selection: answer.selection,
      });
    },
    [sheet, stateKey, mode, target, position],
  );
  return useMemo<Answers>(
    () => ({ staged: block.staged, sent: block.sent, target: mode, stage }),
    [block.staged, block.sent, mode, stage],
  );
}

/** The gallery's stand-in for the composer: what this example's picks would put in the user's message. */
function AnswersPreview({ text }: { text: string }) {
  return (
    <div role="status" className="mt-3 flex min-w-0 flex-col gap-1 rounded-lg bg-surface-recessed px-3 py-2">
      <span className="text-xs font-medium leading-4 text-muted-foreground">In a thread, your message would get</span>
      <p className="m-0 whitespace-pre-wrap text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]">{text}</p>
    </div>
  );
}

/**
 * Stacks the rendered content over its source chrome. In a chat reply that is
 * a Source toggle shown on hover, so replies stay quiet; with `gallery` it is
 * the gallery's footer naming the example, always shown. Both open the same
 * source panel (FrameFooter.tsx).
 */
export function Frame({
  source,
  language = "ui",
  diagnostics,
  files = [],
  gallery,
  markdown,
  children,
}: {
  source: string;
  language?: SourceLanguage;
  diagnostics: readonly Diagnostic[];
  /** What the spec reads with Load and Snippet. */
  files?: readonly SourceFile[];
  /** Set on the gallery page: which example this is. */
  gallery?: GalleryExample;
  /** A rendered ```ui block's current markdown, for "Copy as markdown"; apps and failures have none. */
  markdown?: () => string;
  children: ReactNode;
}) {
  const motion = useMotionScope();
  // data-bb-image-preview-ignore: the components size and open their own
  // images; an image-preview plugin restyling every <img> would break them.
  return gallery === undefined ? (
    <div {...motion} data-bb-image-preview-ignore="" className="group/genui not-prose my-3 flex flex-col gap-3">
      {children}
      <ReplySource source={source} language={language} files={files} diagnostics={diagnostics} markdown={markdown} />
    </div>
  ) : (
    <div
      {...motion}
      data-bb-image-preview-ignore=""
      role="group"
      aria-label={exampleTitle(gallery)}
      className="group/genui not-prose my-3 flex flex-col gap-1.5"
    >
      {children}
      <GalleryFooter
        example={gallery}
        source={source}
        language={language}
        files={files}
        diagnostics={diagnostics}
        markdown={markdown}
      />
    </div>
  );
}

/** Shown in place of a UI that cannot render, with the reason and its source. */
export function RenderFailure({
  source,
  diagnostics,
  gallery,
}: {
  source: string;
  diagnostics: readonly Diagnostic[];
  gallery?: GalleryExample;
}) {
  return (
    <Frame source={source} diagnostics={diagnostics} gallery={gallery}>
      <div
        role="alert"
        className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs"
      >
        <p className="mb-1.5 font-medium text-destructive">This UI couldn't be rendered</p>
        <DiagnosticList diagnostics={diagnostics} />
      </div>
    </Frame>
  );
}
