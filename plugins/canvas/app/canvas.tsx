import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import type { CanvasDocument, Diagnostic, RenderOutput } from "../shared/document.ts";
import { collectDiagnostics } from "../shared/walk.ts";
import { fileNameOf, isCanvasPath, narrowSource } from "../shared/source.ts";
import type { CanvasSource } from "../shared/source.ts";
import { PaletteProvider } from "./charts.tsx";
import { buttonClass } from "./components.tsx";
import { CanvasBoundary } from "./query-client.ts";
import { Nodes, ProblemBar, ProblemCard } from "./render.tsx";
import { canvasPanelRoute, encodeCanvasSubPath, PANEL_PATH } from "./route.ts";
import { rpc } from "./rpc.ts";
import { CanvasProvider, CanvasStateProvider, useCanvas, useCanvasState } from "./state.tsx";

export const pollIntervalMs = 1500;

interface LastGood {
  readonly sha256: string;
  readonly document: CanvasDocument;
  readonly renderedAt: number;
}

interface LastBad {
  readonly sha256: string;
  readonly diagnostic: Diagnostic;
}

const unreadableText: Readonly<
  Record<Extract<RenderOutput, { status: "unreadable" }>["reason"], string>
> = {
  missing: "The canvas file does not exist.",
  "too-large": "The canvas file is larger than the 2 MB limit.",
  binary: "The canvas file is not UTF-8 text.",
  "host-offline": "The host that owns this file is not reachable.",
  "no-worktree": "This workspace has no worktree on disk.",
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function Toolbar(props: { readonly renderedAt: number | null }): ReactElement {
  const canvas = useCanvas();
  const state = useCanvasState();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-xs">
      <span className="font-medium text-foreground">{canvas.fileName}</span>
      <span
        className="flex items-center gap-1 text-muted-foreground"
        title="Live: polls the file for changes"
      >
        <span
          aria-hidden="true"
          className={`inline-block size-1.5 rounded-full ${props.renderedAt === null ? "bg-muted-foreground" : "bg-emerald-500"}`}
        />
        {props.renderedAt === null ? "waiting" : `live, rendered ${formatTime(props.renderedAt)}`}
      </span>
      {state.pending ? <span className="text-muted-foreground">saving</span> : null}
      {state.error !== null ? (
        <button
          type="button"
          className="text-red-600 hover:underline dark:text-red-400"
          onClick={state.retry}
        >
          Could not save state. Retry
        </button>
      ) : null}
    </div>
  );
}

function Banner(props: { readonly diagnostic: Diagnostic; readonly stale: boolean }): ReactElement {
  return (
    <div className="border-b border-border bg-amber-500/10 px-3 py-2 text-sm">
      <p className="m-0 mb-1 font-medium text-amber-600 dark:text-amber-400">
        {props.stale
          ? "The file changed but no longer parses. Showing the last good render."
          : "The file does not parse."}
      </p>
      <ProblemCard diagnostic={props.diagnostic} />
    </div>
  );
}

function CanvasFrame(props: {
  readonly Original: PluginFileOpenerProps["Original"];
}): ReactElement {
  const canvas = useCanvas();
  const [lastGood, setLastGood] = useState<LastGood | null>(null);
  const [lastBad, setLastBad] = useState<LastBad | null>(null);
  const known = useRef<string | null>(null);
  const query = rpc.render.useQuery(
    {
      source: canvas.source,
      knownSha256: known.current,
    },
    {
      refetchInterval: pollIntervalMs,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      staleTime: 0,
      placeholderData: (previous) => previous,
    },
  );
  const data = query.data;

  useEffect(() => {
    if (data === undefined) return;
    if (data.status === "rendered") {
      known.current = data.sha256;
      setLastGood({ sha256: data.sha256, document: data.document, renderedAt: Date.now() });
      setLastBad(null);
    } else if (data.status === "unparseable") {
      known.current = data.sha256;
      setLastBad({ sha256: data.sha256, diagnostic: data.diagnostic });
    }
  }, [data]);

  const stale = lastBad !== null && lastGood !== null && lastBad.sha256 !== lastGood.sha256;
  const unparseable = lastBad?.diagnostic ?? null;
  const unreadable = data !== undefined && data.status === "unreadable" ? data : null;
  const showing = lastGood?.document ?? null;
  const diagnostics = showing === null ? [] : collectDiagnostics(showing);

  if (canvas.view === "source") {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span>Source of {canvas.fileName}</span>
          <span className="flex-1" />
          <button type="button" className={buttonClass} onClick={() => canvas.setView("canvas")}>
            Back to canvas
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <props.Original />
        </div>
      </div>
    );
  }

  if (showing === null && data === undefined) {
    return (
      <div className="flex h-full flex-col">
        <Toolbar renderedAt={null} />
        <p className="px-3 py-2 text-sm text-muted-foreground">Loading canvas</p>
      </div>
    );
  }

  if (showing === null && unreadable !== null) {
    return (
      <div className="flex h-full flex-col">
        <Toolbar renderedAt={null} />
        <div className="m-3 rounded-md border border-border px-3 py-2 text-sm">
          <p className="m-0 font-medium text-foreground">{unreadableText[unreadable.reason]}</p>
          <p className="m-0 mt-1 text-muted-foreground">{unreadable.detail}</p>
          <p className="m-0 mt-1 font-mono text-xs text-muted-foreground">{canvas.path}</p>
          <button type="button" className={`mt-2 ${buttonClass}`} onClick={() => query.refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (showing === null && query.error !== null) {
    return (
      <div className="flex h-full flex-col">
        <Toolbar renderedAt={null} />
        <div className="m-3 rounded-md border border-border px-3 py-2 text-sm">
          <p className="m-0 font-medium text-foreground">The canvas could not be loaded.</p>
          <p className="m-0 mt-1 text-muted-foreground">{query.error.message}</p>
          <button type="button" className={`mt-2 ${buttonClass}`} onClick={() => query.refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (showing === null) {
    return (
      <div className="flex h-full flex-col">
        <Toolbar renderedAt={null} />
        {unparseable !== null ? <Banner diagnostic={unparseable} stale={false} /> : null}
        <div className="min-h-0 flex-1">
          <props.Original />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Toolbar renderedAt={lastGood?.renderedAt ?? null} />
      {unparseable !== null && stale ? <Banner diagnostic={unparseable} stale /> : null}
      {unreadable !== null ? (
        <div className="border-b border-border bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
          {unreadableText[unreadable.reason]} Showing the last good render.
        </div>
      ) : null}
      <ProblemBar diagnostics={diagnostics} />
      <div
        className={`canvas-scroll min-h-0 flex-1 overflow-auto ${stale || unreadable !== null ? "opacity-60" : ""}`}
      >
        <div className="canvas-prose" data-canvas-style={showing.style}>
          <Nodes nodes={showing.nodes} />
        </div>
      </div>
    </div>
  );
}

export function CanvasView(props: {
  readonly source: CanvasSource;
  readonly path: string;
  readonly Original: PluginFileOpenerProps["Original"];
}): ReactElement {
  return (
    <CanvasBoundary>
      <CanvasProvider source={props.source} path={props.path}>
        <PaletteProvider>
          <CanvasStateProvider>
            <CanvasFrame Original={props.Original} />
          </CanvasStateProvider>
        </PaletteProvider>
      </CanvasProvider>
    </CanvasBoundary>
  );
}

// bb opens an app-route anchor in a split pane when a plugin slot receives a
// modifier click on it (the same rule as cmd-clicking a sidebar row). The SDK
// has no split API for panels, so the opener drives that host rule with a
// synthetic click. A document listener runs after the host's delegate: when
// nothing claimed the click, it cancels the anchor's own navigation and falls
// back to plain panel navigation instead.
export function openRouteInSplit(anchor: HTMLAnchorElement, fallback: () => void): void {
  const doc = anchor.ownerDocument;
  const settle = (event: Event): void => {
    doc.removeEventListener("click", settle);
    if (event.defaultPrevented) return;
    event.preventDefault();
    fallback();
  };
  doc.addEventListener("click", settle);
  anchor.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true, button: 0 }),
  );
  doc.removeEventListener("click", settle);
}

function CanvasHandoff(props: {
  readonly source: CanvasSource;
  readonly path: string;
  readonly Original: PluginFileOpenerProps["Original"];
}): ReactElement {
  const { source, path } = props;
  const navigate = useBbNavigate();
  const [inline, setInline] = useState(false);
  const anchor = useRef<HTMLAnchorElement | null>(null);
  const subPath = encodeCanvasSubPath(source);
  const openPane = useCallback(() => {
    const element = anchor.current;
    if (element === null) return;
    openRouteInSplit(element, () => navigate.toPluginPanel(PANEL_PATH, { subPath }));
  }, [navigate, subPath]);

  useEffect(() => {
    openPane();
  }, [openPane]);

  if (inline) return <CanvasView source={source} path={path} Original={props.Original} />;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-xs">
        <span className="font-medium text-foreground">{fileNameOf(path)}</span>
        <span className="text-muted-foreground">opens in its own pane</span>
      </div>
      <div className="m-3 flex flex-wrap items-center gap-2 text-sm">
        <a
          ref={anchor}
          href={canvasPanelRoute(source)}
          className={buttonClass}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            openPane();
          }}
        >
          Open pane
        </a>
        <button type="button" className={buttonClass} onClick={() => setInline(true)}>
          Show here
        </button>
      </div>
    </div>
  );
}

export function CanvasOpener(props: PluginFileOpenerProps): ReactElement {
  const [optedIn, setOptedIn] = useState(false);
  const narrowed = narrowSource(props.source, props.path);
  if (!narrowed.ok) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          Canvas cannot resolve this file ({narrowed.reason}). Showing the default preview.
        </div>
        <div className="min-h-0 flex-1">
          <props.Original />
        </div>
      </div>
    );
  }
  if (!isCanvasPath(props.path) && !optedIn) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span>Not a .canvas.mdx file.</span>
          <button type="button" className={buttonClass} onClick={() => setOptedIn(true)}>
            Open as canvas
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <props.Original />
        </div>
      </div>
    );
  }
  if (optedIn) {
    return <CanvasView source={narrowed.value} path={props.path} Original={props.Original} />;
  }
  return <CanvasHandoff source={narrowed.value} path={props.path} Original={props.Original} />;
}
