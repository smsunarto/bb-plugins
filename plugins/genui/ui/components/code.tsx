// Code, file snippets, diffs and diagrams drawn by BB's own viewers, so they
// carry the user's code theme, highlighting and gutters exactly like code
// elsewhere in BB.
import { type MouseEvent, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  experimental_Diff as HostDiff,
  experimental_SourceCode as HostSourceCode,
  Markdown,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { useCodeHeight } from "../codeHeight";
import { useUiRuntime } from "../runtime";
import { useSketchFont } from "../sketchFont";
import { useBackdropColor, useDarkTheme } from "../theme";
import { finiteNumber, optionalText, text, type Props } from "../values";
import { DIAGRAM_SVG, DiagramDetails, DiagramViewer } from "./diagram";
import { ErrorLine } from "./display";
import { parseDetails } from "./explain-logic";
import { sketchMermaid } from "./sketch";
import { usePanZoom } from "./viewer";

/** Language names models write → the file extension BB detects languages by. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  ruby: "rb",
  rust: "rs",
  golang: "go",
  shell: "sh",
  bash: "sh",
  zsh: "sh",
  console: "sh",
  kotlin: "kt",
  csharp: "cs",
  "c#": "cs",
  "c++": "cpp",
  markdown: "md",
  yaml: "yml",
  text: "txt",
  plaintext: "txt",
};

const ICON_BUTTON =
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * A bordered code surface with a quiet caption bar. With `lines` (Code and
 * Snippet; null while unknown) the body holds the height BB's viewer will
 * draw that many lines at while it loads (codeHeight.ts).
 */
function CodeFrame({ caption, actions, lines, children }: { caption: ReactNode; actions: ReactNode; lines?: number | null; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  useCodeHeight(body, lines ?? null);
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex h-8 items-center justify-between gap-3 border-b border-border bg-surface-recessed pl-3 pr-1.5 text-[11px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2 font-mono">{caption}</span>
        {actions}
      </div>
      <div ref={body} className="max-h-96 overflow-auto text-xs">
        {children}
      </div>
    </div>
  );
}

function CopyButton({ code }: { code: string }) {
  const { run } = useUiRuntime();
  return (
    <button
      type="button"
      title="Copy code"
      aria-label="Copy code"
      onClick={() => run([{ kind: "action", type: "copy", text: code }])}
      className={ICON_BUTTON}
    >
      <Icon name="Copy" className="size-3.5" />
    </button>
  );
}

/**
 * The path BB's viewer gets for `content`. The viewer caches what it renders
 * by path, so two blocks with one path but different content (two bash
 * snippets, two ranges of one file) would show each other's lines; a content
 * hash in front keeps them apart and leaves the extension for highlighting.
 */
export function viewerPath(path: string, content: string): string {
  // FNV-1a: fast, and collisions only cost a stale highlight.
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash = Math.imul(hash ^ content.charCodeAt(index), 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}/${path}`;
}

/** How many times a hidden ancestor (an inactive tab, a closed Details) took away `element`'s box after it was shown. */
function useTimesHidden(element: RefObject<HTMLElement | null>): number {
  const [count, setCount] = useState(0);
  // From layout, where BB's viewer starts watching too: a hide right after mounting isn't missed.
  useLayoutEffect(() => {
    const box = element.current;
    if (box === null) return;
    let shown = false;
    const observer = new ResizeObserver(() => {
      const visible = box.getClientRects().length > 0;
      if (shown && !visible) setCount((value) => value + 1);
      shown = visible;
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [element]);
  return count;
}

/**
 * BB's source viewer, made anew each time it is hidden. Hidden by
 * display:none, the viewer BB 0.46 ships (@pierre/diffs 1.2.9's
 * VirtualizedFile) swaps its lines for a blank placeholder and, shown again,
 * keeps it: it still counts the lines as drawn. A viewer made while hidden
 * draws its lines at once (the first 200 or so; further down, a frame after
 * it is shown), so the box comes back drawn and at its height.
 * @pierre/diffs 1.3.0 fixed it; this can go once BB ships that.
 */
export function SourceView({ content, path }: { content: string; path: string }) {
  const box = useRef<HTMLDivElement>(null);
  const hidden = useTimesHidden(box);
  return (
    <div ref={box}>
      <HostSourceCode key={hidden} content={content} path={path} overflow="scroll" />
    </div>
  );
}

export function Code({ props }: { props: Props }) {
  const code = text(props.code);
  const language = optionalText(props.language)?.trim().toLowerCase() || null;
  const extension = language === null ? "txt" : (EXTENSIONS[language] ?? language.replace(/[^a-z0-9]/g, "")) || "txt";
  return (
    <CodeFrame caption={<span className="truncate">{language ?? "code"}</span>} actions={<CopyButton code={code} />} lines={code.split("\n").length}>
      <SourceView content={code} path={viewerPath(`snippet.${extension}`, code)} />
    </CodeFrame>
  );
}

/**
 * Lines of a workspace file, read by reference (`code` is null while the file
 * loads). BB's viewer numbers the lines it is given from 1, so the caption
 * carries the file's real line range.
 */
export function Snippet({ props }: { props: Props }) {
  const { openFile } = useUiRuntime();
  const path = text(props.path);
  const requestedFrom = finiteNumber(props.from);
  const from = requestedFrom ?? 1;
  const to = finiteNumber(props.to);
  const code = typeof props.code === "string" ? props.code : null;
  const error = optionalText(props.error);
  let range: string | null;
  if (code !== null && error === null) {
    // What is shown, after clamping to the file and the line cap.
    const last = from + code.split("\n").length - 1;
    range = last === from ? `L${from}` : `L${from}–${last}`;
  } else {
    range = to !== null ? `L${from}–${to}` : requestedFrom !== null ? `L${from}+` : null;
  }
  const label = range === null ? path : `${path} ${range}`;

  let body: ReactNode;
  if (error !== null) {
    body = (
      <div className="px-3 py-2.5">
        <ErrorLine message={`Couldn't show ${label}: ${error}`} />
      </div>
    );
  } else if (code === null) {
    body = (
      <div role="status" aria-label={`Loading ${label}`} className="flex flex-col gap-2 px-3 py-3">
        {["w-3/5", "w-4/5", "w-2/5", "w-1/2"].map((width) => (
          <div key={width} className={`h-3 animate-pulse rounded-sm bg-muted motion-reduce:animate-none ${width}`} />
        ))}
      </div>
    );
  } else {
    body = <SourceView content={code} path={viewerPath(path, code)} />;
  }

  // The viewer draws one line per newline-separated part; while the file loads, the range asked for is the best guess.
  const lines = error !== null ? null : code !== null ? code.split("\n").length : to !== null && to >= from ? to - from + 1 : null;
  return (
    <CodeFrame
      lines={lines}
      caption={
        <>
          <span className="truncate text-foreground" title={path}>
            {path}
          </span>
          {range === null ? null : <span className="shrink-0 tabular-nums">{range}</span>}
        </>
      }
      actions={
        <span className="flex shrink-0 items-center gap-0.5">
          {openFile === null ? null : (
            <button
              type="button"
              title={`Open ${path}`}
              aria-label={`Open ${path}`}
              onClick={async () => {
                if (!(await openFile(path, from))) toast.error(`Couldn't open ${path}`);
              }}
              className={ICON_BUTTON}
            >
              <Icon name="FileText" className="size-3.5" />
            </button>
          )}
          {code === null || error !== null ? null : <CopyButton code={code} />}
        </span>
      }
    >
      {body}
    </CodeFrame>
  );
}

/** The file a unified patch changes, from its header: the new side, or the old one for a deletion. */
function patchPath(patch: string): string | null {
  // Only before the first hunk: a removed `-- comment` line inside one looks like a header.
  const header = patch.split(/^@@/m)[0]!;
  for (const match of header.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S.*?)\s*$/gm)) {
    if (match[1] !== "/dev/null") return match[1]!;
  }
  return /^diff --git a\/\S+ b\/(\S+)/m.exec(header)?.[1] ?? null;
}

export function Diff({ props }: { props: Props }) {
  const patch = text(props.patch);
  const path = patchPath(patch);
  const lines = patch.split("\n");
  const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return (
    <CodeFrame
      caption={
        <>
          <span className="truncate text-foreground">{path ?? "diff"}</span>
          <span className="shrink-0 tabular-nums text-success">+{added}</span>
          <span className="shrink-0 tabular-nums text-destructive">−{removed}</span>
        </>
      }
      actions={null}
    >
      {/* Without a header the host completes the patch from `path`. */}
      <HostDiff patch={patch} path={path ?? "file"} overflow="scroll" />
    </CodeFrame>
  );
}

/**
 * BB's diagram block, stripped to the drawing: no border, background or
 * padding, and its toolbar (source, zoom, copy) a quiet row of icons at the
 * top right, without the "MERMAID" label. Floating it over the drawing would
 * cover nodes in wide diagrams. Styled by structure (block > toolbar, body >
 * the SVG's frame), so if BB's markup changes the block simply keeps its own
 * frame. A pinched drawing is zoomed inside its own box: the body clips it.
 */
const DRAWING_CSS = `
.genui-drawing>div{margin:0;border:0;border-radius:0;background:transparent}
.genui-drawing>div>div:first-child{justify-content:flex-end;padding:0;opacity:.7;transition:opacity 150ms}
.genui-drawing:hover>div>div:first-child,.genui-drawing>div>div:first-child:focus-within{opacity:1}
.genui-drawing>div>div:first-child>span{display:none}
.genui-drawing>div>div:last-child{padding:0;overflow:hidden}
.genui-drawing>div>div:last-child>div{transform-origin:0 0}
@media (prefers-reduced-motion:reduce){.genui-drawing>div>div:first-child{transition:none}}
`;

/**
 * BB's open button in the diagram's toolbar. Its dialog's pinch listeners
 * attach before the dialog mounts, so on a touch screen it only pans; the
 * diagram opens in DiagramViewer instead. Matched by label: if BB renames
 * it, BB's own dialog simply opens again.
 */
const OPEN_BUTTON = 'button[aria-label="Open Mermaid diagram"]';

/**
 * Each drawing's last height, by theme, width and source, kept across reloads
 * (a page opens a thread's old diagrams for the first time too); bounded.
 */
const HEIGHTS_STORAGE = "bb.genui.drawnHeights";
const MAX_DRAWN_HEIGHTS = 300;
const DRAWN_HEIGHTS: Map<string, number> = (() => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(HEIGHTS_STORAGE) ?? "[]");
    return new Map(Array.isArray(stored) ? (stored as [string, number][]) : []);
  } catch {
    return new Map();
  }
})();

function rememberHeight(key: string, height: number): void {
  if (DRAWN_HEIGHTS.get(key) === height) return;
  DRAWN_HEIGHTS.delete(key);
  DRAWN_HEIGHTS.set(key, height);
  if (DRAWN_HEIGHTS.size > MAX_DRAWN_HEIGHTS) DRAWN_HEIGHTS.delete(DRAWN_HEIGHTS.keys().next().value!);
  try {
    localStorage.setItem(HEIGHTS_STORAGE, JSON.stringify([...DRAWN_HEIGHTS]));
  } catch {
    // Storage full or unavailable: heights hold within this page only.
  }
}

/** FNV-1a: a short stable key for a diagram's source. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  return (value >>> 0).toString(36);
}

/**
 * Mermaid draws asynchronously, after the row holding the diagram is laid
 * out, and BB draws it only once it comes within 256 px of the screen. Until
 * the drawing is there, the box holds exactly the height it had last time at
 * this width, so the conversation doesn't move under the reader. A diagram
 * never drawn here keeps the tallest of its placeholders (the font loading,
 * then BB's "Rendering diagram..."), so it moves once, when it draws.
 */
function useDrawnHeight(element: RefObject<HTMLDivElement | null>, dark: boolean, source: string): void {
  useLayoutEffect(() => {
    const box = element.current;
    if (box === null) return;
    // Wide diagrams scale to the width, so their height depends on it.
    const key = `${dark ? "d" : "l"}:${Math.round(box.clientWidth / 40)}:${hash(source)}`;
    const drawn = () => box.querySelector("svg[aria-roledescription]") !== null;
    // Drawn, or BB showing the source instead (its toggle, or a diagram it couldn't draw).
    const settled = () => drawn() || box.querySelector("pre") !== null;
    const reserved = DRAWN_HEIGHTS.get(key);
    let holding = !settled();
    if (holding && reserved !== undefined) {
      box.style.height = `${reserved}px`;
      box.style.overflow = "clip";
    } else if (holding) {
      box.style.minHeight = `${box.offsetHeight}px`;
    }
    const release = () => {
      holding = false;
      box.style.height = "";
      box.style.minHeight = "";
      box.style.overflow = "";
    };
    const observer = new ResizeObserver(() => {
      // A placeholder taller than the last one raises the floor.
      if (holding && reserved === undefined) box.style.minHeight = `${box.offsetHeight}px`;
      if (!holding && drawn()) rememberHeight(key, box.offsetHeight);
    });
    // A box held at a fixed height doesn't resize as its content changes: watch the content.
    const content = new MutationObserver(() => {
      if (!holding || !settled()) return;
      release();
      if (drawn()) rememberHeight(key, box.offsetHeight);
    });
    observer.observe(box);
    content.observe(box, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      content.disconnect();
      release();
    };
  }, [element, dark, source]);
}

/**
 * A Mermaid diagram, drawn by BB's chat markdown exactly like a ```mermaid
 * fence in a reply (source toggle and copy included), in the Excalidraw
 * style (sketch.ts): hand-drawn strokes in Excalifont, in its dark palette
 * under BB's dark theme. It has no frame or canvas of its own: it is drawn on
 * whatever it sits in, and edge labels take that colour. Nodes named in
 * `details` open their detail under the diagram (diagram.tsx). A pinch or
 * ⌘/Ctrl + scroll zooms it in place; BB's open button shows it full screen
 * in DiagramViewer.
 */
export function Diagram({ props }: { props: Props }) {
  const fontReady = useSketchFont();
  const dark = useDarkTheme();
  const host = useRef<HTMLDivElement>(null);
  const drawing = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const attach = useCallback((element: HTMLDivElement | null) => {
    drawing.current = element;
    setSurface(element);
  }, []);
  const [full, setFull] = useState<{ readonly markup: string; readonly size: { width: number; height: number } } | null>(null);
  const backdrop = useBackdropColor(host, dark);
  const source = text(props.mermaid).trim();
  useDrawnHeight(drawing, dark, source);
  // The SVG's frame in BB's block is what zooms; its parent, the block's body, is the pane.
  const frameOf = () => surface?.querySelector(DIAGRAM_SVG)?.parentElement ?? null;
  const zoom = usePanZoom(surface, {
    measure: () => {
      const frame = frameOf();
      const body = frame?.parentElement;
      if (!(frame instanceof HTMLElement) || !body) return null;
      const rect = body.getBoundingClientRect();
      const size = { width: frame.offsetWidth, height: frame.offsetHeight };
      return { left: rect.left + body.clientLeft, top: rect.top + body.clientTop, pane: size, content: size };
    },
    draw: (placed, view) => {
      const frame = frameOf();
      if (frame instanceof HTMLElement) frame.style.transform = view.zoom > 1 ? `translate(${placed.x}px, ${placed.y}px) scale(${placed.scale})` : "";
    },
    plainWheel: false,
    doubleTap: false,
  });
  const { redraw } = zoom;
  // BB's Markdown can replace the drawn block when its row renders again (a layout change,
  // a panel opening), dropping the transform set on the old frame; draw the view again on
  // the new one, so a zoomed diagram stays zoomed and keeps panning.
  useEffect(() => {
    if (surface === null) return;
    const observer = new MutationObserver(() => redraw());
    observer.observe(surface, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [surface, redraw]);
  if (source === "") return <ErrorLine message="This diagram has no Mermaid source" />;
  const details = parseDetails(props.details);
  // A fence longer than any backtick run in the source keeps it one block.
  const longestRun = Math.max(0, ...Array.from(source.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));

  const openFull = (event: MouseEvent) => {
    const svg = drawing.current?.querySelector<SVGSVGElement>(DIAGRAM_SVG);
    if (!(event.target instanceof Element) || event.target.closest(OPEN_BUTTON) === null || !svg) return;
    event.preventDefault();
    event.stopPropagation();
    const box = svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    setFull({ markup: svg.outerHTML, size: box !== null && box.width > 0 && box.height > 0 ? { width: box.width, height: box.height } : { width: rect.width, height: rect.height } });
  };

  // Mermaid measures text as it lays out, so the font comes first.
  const diagram = (
    <div
      ref={attach}
      onClickCapture={openFull}
      // At its fitted size one finger scrolls the thread; zoomed in, it pans the drawing.
      style={{ touchAction: zoom.zoomed ? "none" : "pan-x pan-y" }}
      className="relative min-w-0"
    >
      {fontReady && backdrop !== null ? (
        <Markdown
          content={`${fence}mermaid\n${sketchMermaid(source, dark, backdrop)}\n${fence}`}
          className="genui-drawing min-w-0 text-sm"
        />
      ) : (
        <div role="status" aria-label="Drawing diagram" className="h-40 animate-pulse rounded-lg bg-surface-recessed" />
      )}
      {zoom.zoomed ? (
        <button
          type="button"
          onClick={zoom.reset}
          className="absolute left-0 top-0 inline-flex h-7 cursor-pointer items-center gap-1 rounded-md bg-surface-scrim/90 px-2 text-xs text-muted-foreground backdrop-blur-sm transition-colors duration-150 hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="RotateCcw" aria-hidden className="size-3.5" />
          Reset zoom
        </button>
      ) : null}
    </div>
  );
  return (
    <div ref={host} className="flex min-w-0 flex-col gap-1.5">
      <style href="genui-drawing" precedence="default">
        {DRAWING_CSS}
      </style>
      {details === null || details.length === 0 ? diagram : <DiagramDetails details={details}>{diagram}</DiagramDetails>}
      {details === null ? <ErrorLine message="Diagram details need an object of {nodeId: text or components}" /> : null}
      {full === null ? null : (
        <DiagramViewer
          markup={full.markup}
          size={full.size}
          source={source}
          details={details}
          onClose={() => {
            // Gone first: while it is open, the viewer keeps focus inside itself.
            flushSync(() => setFull(null));
            drawing.current?.querySelector<HTMLElement>(OPEN_BUTTON)?.focus();
          }}
        />
      )}
    </div>
  );
}
