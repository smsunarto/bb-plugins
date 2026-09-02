import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { prepareRemoteSession, type RemoteSessionState } from "./remote-session.ts";

export type PipMode = "hidden" | "pip" | "expanded";

const DOCK_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

type DockCorner = (typeof DOCK_CORNERS)[number];

type Rect = { left: number; right: number; top: number; bottom: number };

type DockLayout = {
  viewportWidth: number;
  viewportHeight: number;
  // The thread section: below the header, left of the right sidebar.
  area: Rect;
  // The composer stack, including the bars other surfaces inject above it
  // (committed-diff bar, annotation bar, ...). Null off thread pages.
  stack: { left: number; right: number; top: number } | null;
};

const ASPECT = 16 / 9;
const PIP_WIDTH = 320;
const PIP_HEIGHT = PIP_WIDTH / ASPECT;
const PIP_MARGIN = 16;
const PIP_STACK_GAP = 12;
const EXPANDED_MARGIN = 24;
const SETTLE_TRANSITION = "transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]";

const CHROME_BUTTON_CLASS =
  "flex size-8 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80";

function ChromeIcon(props: { path: string }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="14"
    >
      <path d={props.path} />
    </svg>
  );
}

function ChromeButton(props: { label: string; onClick?: () => void; href?: string; children: ReactNode }) {
  if (props.href !== undefined) {
    return (
      <a
        aria-label={props.label}
        className={CHROME_BUTTON_CLASS}
        href={props.href}
        onPointerDown={(event) => event.stopPropagation()}
        rel="noreferrer"
        target="_blank"
        title={props.label}
      >
        {props.children}
      </a>
    );
  }
  return (
    <button
      aria-label={props.label}
      className={CHROME_BUTTON_CLASS}
      onClick={props.onClick}
      onPointerDown={(event) => event.stopPropagation()}
      title={props.label}
      type="button"
    >
      {props.children}
    </button>
  );
}

// The composer form and its injected sibling bars share the centered
// .chat-prompt-box wrapper, and its enclosing .thread-scrollbar is the
// thread section (it shrinks when the right sidebar opens). Both are bb
// app internals, so each has a fallback when the class disappears.
function measureLayout(): DockLayout {
  const stackElement = document.querySelector(".chat-prompt-box");
  const areaElement = stackElement?.closest(".thread-scrollbar") ?? document.querySelector('main[data-sidebar="inset"]');
  const areaRect = areaElement?.getBoundingClientRect();
  const area: Rect =
    areaRect === undefined
      ? { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight }
      : { left: areaRect.left, right: areaRect.right, top: areaRect.top, bottom: areaRect.bottom };
  let stack: DockLayout["stack"] = null;
  if (stackElement !== null) {
    const rect = stackElement.getBoundingClientRect();
    stack = { left: rect.left, right: rect.right, top: rect.top };
  }
  return { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, area, stack };
}

// The pip must never rest over the composer stack. A bottom corner sits
// beside the stack when the column leaves the pip's width of clearance,
// and hops above the stack when it does not, so sidebar resizes reflow it.
function dockPosition(corner: DockCorner, layout: DockLayout): { left: number; top: number } {
  const { area, stack } = layout;
  const onLeft = corner === "top-left" || corner === "bottom-left";
  const left = onLeft ? area.left + PIP_MARGIN : area.right - PIP_WIDTH - PIP_MARGIN;
  if (corner === "top-left" || corner === "top-right") {
    return { left, top: area.top + PIP_MARGIN };
  }
  const clearance = stack === null ? Infinity : onLeft ? stack.left - area.left : area.right - stack.right;
  const besideStackFits = clearance >= PIP_MARGIN + PIP_WIDTH + PIP_STACK_GAP;
  const top =
    stack !== null && !besideStackFits
      ? Math.max(area.top + PIP_MARGIN, stack.top - PIP_HEIGHT - PIP_STACK_GAP)
      : area.bottom - PIP_HEIGHT - PIP_MARGIN;
  return { left, top };
}

function useDockLayout() {
  const [layout, setLayout] = useState(measureLayout);

  useEffect(() => {
    const measure = () => setLayout(measureLayout());
    window.addEventListener("resize", measure);
    // The scrollbar element resizes on both sidebars; the prompt box
    // resizes when a bar is injected above the composer.
    const observer = new ResizeObserver(measure);
    for (const selector of [".chat-prompt-box", ".thread-scrollbar", 'main[data-sidebar="inset"]']) {
      const element = document.querySelector(selector);
      if (element !== null) {
        observer.observe(element);
      }
    }
    measure();
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, []);

  return layout;
}

function DockZone(props: { corner: DockCorner; zone: Rect; target: { left: number; top: number } }) {
  const { isOver, setNodeRef } = useDroppable({ id: props.corner });
  return (
    <>
      <div
        className={`pointer-events-none fixed z-[9998] transition-colors duration-300 ${
          isOver ? "bg-foreground/[0.04]" : "bg-transparent"
        }`}
        ref={setNodeRef}
        style={{
          left: props.zone.left,
          top: props.zone.top,
          width: props.zone.right - props.zone.left,
          height: props.zone.bottom - props.zone.top,
        }}
      />
      {isOver ? (
        <div
          className="pointer-events-none fixed z-[9998] rounded-xl border-2 border-dashed border-foreground/30"
          style={{ left: props.target.left, top: props.target.top, width: PIP_WIDTH, height: PIP_HEIGHT }}
        />
      ) : null}
    </>
  );
}

function PipFrame(props: {
  mode: Exclude<PipMode, "hidden">;
  url: string;
  dockCorner: DockCorner;
  onExpand: () => void;
  onMinimize: () => void;
}) {
  const { mode, url, dockCorner, onExpand, onMinimize } = props;
  const [hovered, setHovered] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [sessionState, setSessionState] = useState<RemoteSessionState | "preparing">("preparing");
  const [waitingForLogin, setWaitingForLogin] = useState(false);
  const layout = useDockLayout();
  const expanded = mode === "expanded";

  const prepareSession = useCallback(async () => {
    setSessionState("preparing");
    const next = await prepareRemoteSession();
    setSessionState(next);
    if (next === "ready") {
      setFrameKey((key) => key + 1);
    }
  }, []);

  useEffect(() => {
    void prepareSession();
  }, [prepareSession]);

  useEffect(() => {
    if (!waitingForLogin) return;
    let leftBb = false;
    const markLeft = () => {
      leftBb = true;
    };
    const reloadAfterReturn = () => {
      if (!leftBb || document.visibilityState === "hidden") return;
      setWaitingForLogin(false);
      setSessionState("ready");
      setFrameKey((key) => key + 1);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") markLeft();
      else reloadAfterReturn();
    };
    window.addEventListener("blur", markLeft);
    window.addEventListener("focus", reloadAfterReturn);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", markLeft);
      window.removeEventListener("focus", reloadAfterReturn);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [waitingForLogin]);

  // attributes is left unspread: its role="button" would nest the chrome's
  // real buttons inside a button role. Dragging is pointer-only.
  const { isDragging, listeners, setNodeRef, transform } = useDraggable({
    id: "novnc-pip",
    disabled: expanded,
  });

  useEffect(() => {
    if (!expanded) {
      return;
    }
    const minimizeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onMinimize();
      }
    };
    window.addEventListener("keydown", minimizeOnEscape);
    return () => {
      window.removeEventListener("keydown", minimizeOnEscape);
    };
  }, [expanded, onMinimize]);

  const availableWidth = layout.viewportWidth - 2 * EXPANDED_MARGIN;
  const availableHeight = layout.viewportHeight - 2 * EXPANDED_MARGIN;
  const expandedWidth = Math.round(Math.min(availableWidth, availableHeight * ASPECT));
  const expandedHeight = Math.round(expandedWidth / ASPECT);

  const dock = dockPosition(dockCorner, layout);
  const frameWidth = expanded ? expandedWidth : PIP_WIDTH;
  const frameHeight = expanded ? expandedHeight : PIP_HEIGHT;
  const frameLeft = expanded ? (layout.viewportWidth - expandedWidth) / 2 : dock.left;
  const frameTop = expanded ? (layout.viewportHeight - expandedHeight) / 2 : dock.top;

  const { area } = layout;
  const midX = (area.left + area.right) / 2;
  const midY = (area.top + area.bottom) / 2;
  const zoneRects: Record<DockCorner, Rect> = {
    "top-left": { left: area.left, right: midX, top: area.top, bottom: midY },
    "top-right": { left: midX, right: area.right, top: area.top, bottom: midY },
    "bottom-left": { left: area.left, right: midX, top: midY, bottom: area.bottom },
    "bottom-right": { left: midX, right: area.right, top: midY, bottom: area.bottom },
  };

  // GitHub OAuth cannot run inside the iframe. The server normally installs a
  // short-lived Connect session before this frame mounts. The browser link is
  // the fallback for local origins that cannot set the gate's parent-domain
  // cookie; returning to bb reloads the frame automatically.
  const chrome = (
    <div className="absolute right-3 top-3 flex gap-2">
      <ChromeButton label="Reload" onClick={() => setFrameKey((key) => key + 1)}>
        <ChromeIcon path="M21 12a9 9 0 1 1-2.64-6.36M21 3v5h-5" />
      </ChromeButton>
      <ChromeButton href={url} label="Open remote screen in browser tab">
        <ChromeIcon path="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      </ChromeButton>
      {expanded ? (
        <ChromeButton label="Minimize remote screen" onClick={onMinimize}>
          <ChromeIcon path="M20 10h-6V4M14 10l7-7M4 14h6v6M10 14l-7 7" />
        </ChromeButton>
      ) : null}
    </div>
  );

  return (
    <>
      {isDragging
        ? DOCK_CORNERS.map((corner) => (
            <DockZone corner={corner} key={corner} target={dockPosition(corner, layout)} zone={zoneRects[corner]} />
          ))
        : null}
      {/* The pip portals into document.body, outside the plugin's
          [data-bb-plugin] mount, so it must carry its own scope root for the
          plugin's compiled stylesheet to reach it. The portaled-overlay marker
          lets Electron route pointer input to it instead of window drag. */}
      <div
        className={`fixed z-[9999] touch-none select-none overflow-hidden rounded-xl border border-border bg-background shadow-2xl ${
          isDragging ? "" : SETTLE_TRANSITION
        }`}
        data-bb-plugin="novnc"
        data-bb-plugin-root=""
        data-bb-portaled-overlay=""
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        ref={setNodeRef}
        style={{
          left: frameLeft,
          top: frameTop,
          width: frameWidth,
          height: frameHeight,
          transform: transform === null ? undefined : `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        }}
        {...(expanded ? {} : listeners)}
      >
        {/* The iframe always renders at the expanded 16:9 size and is scaled
            down in pip mode, so the remote sees a full-size screen instead of
            resizing its display to a 320px window. Scaling instead of
            remounting also keeps one VNC session across pip and expanded. */}
        {/* oxlint-disable react/iframe-missing-sandbox -- the embed is cross-origin, so allow-same-origin only grants NoVNC its own origin's storage, which it needs alongside scripts. */}
        {sessionState === "ready" ? (
          <iframe
            allow="clipboard-read; clipboard-write"
            className={`border-0 ${isDragging ? "" : "transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"}`}
            key={frameKey}
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
            src={url}
            style={{
              width: expandedWidth,
              height: expandedHeight,
              transform: expanded ? "scale(1)" : `scale(${PIP_WIDTH / expandedWidth})`,
              transformOrigin: "top left",
            }}
            title="Remote screen"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-background px-6 text-center">
            {sessionState === "preparing" ? (
              <div className="space-y-2">
                <div
                  aria-hidden="true"
                  className="mx-auto size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
                />
                <p className="text-sm font-medium text-foreground">Preparing remote screen…</p>
              </div>
            ) : (
              <div className="max-w-sm space-y-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Sign in to remote access</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {waitingForLogin
                      ? "Finish sign-in in the new tab, then return here."
                      : "Open one browser tab to sign in. The screen reloads when you return."}
                  </p>
                </div>
                <div className="flex justify-center gap-2">
                  <a
                    className="rounded-md bg-foreground px-3 py-2 text-xs font-medium text-background"
                    href={url}
                    onClick={() => setWaitingForLogin(true)}
                    onPointerDown={(event) => event.stopPropagation()}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {waitingForLogin ? "Open sign-in again" : "Sign in in browser"}
                  </a>
                  <button
                    className="rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground"
                    onClick={() => void prepareSession()}
                    onPointerDown={(event) => event.stopPropagation()}
                    type="button"
                  >
                    Try again
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {/* oxlint-enable react/iframe-missing-sandbox */}
        {expanded ? (
          chrome
        ) : sessionState === "ready" ? (
          // A cross-origin iframe swallows mouse events, so this overlay
          // owns hover and keeps the pip a click-to-expand preview.
          <div className="absolute inset-0 flex items-center justify-center">
            {hovered && !isDragging ? (
              <>
                <button
                  className="flex items-center gap-2 rounded-full bg-black/80 px-4 py-2 text-sm font-medium text-white"
                  onClick={onExpand}
                  type="button"
                >
                  <ChromeIcon path="M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7" />
                  Open
                </button>
                {chrome}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function NovncPip(props: {
  mode: Exclude<PipMode, "hidden">;
  url: string;
  onExpand: () => void;
  onMinimize: () => void;
}) {
  const [dockCorner, setDockCorner] = useState<DockCorner>("bottom-right");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  return (
    <DndContext
      collisionDetection={pointerWithin}
      onDragEnd={(event) => {
        const over = event.over?.id;
        if (typeof over === "string" && (DOCK_CORNERS as readonly string[]).includes(over)) {
          setDockCorner(over as DockCorner);
        }
      }}
      sensors={sensors}
    >
      <PipFrame dockCorner={dockCorner} {...props} />
    </DndContext>
  );
}
