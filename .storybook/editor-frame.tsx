/* oxlint-disable jsx-a11y/prefer-tag-over-role -- This focusable ARIA separator is an interactive window splitter, not a static hr. */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { EditorContext } from "./editor-context";
import "./editor-frame.css";

function Navigation({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <aside className="sb-editor-nav">
      <div className="sb-editor-brand" aria-hidden="true">
        <b>bb</b>
        <span>⌘ K</span>
      </div>
      <div className="sb-editor-navigation" aria-hidden="true">
        <div>
          ＋ <span>New thread</span>
        </div>
        <div>
          ◷ <span>Threads</span>
        </div>
        <div className="sb-editor-nav-active">
          ▣ <span>{title}</span>
        </div>
      </div>
      <div className="sb-editor-project" aria-hidden="true">
        ⌄ <span>Atlas</span>
        <small>PROJECT</small>
      </div>
      {children ? (
        <div className="sb-editor-sidebar-slot">{children}</div>
      ) : (
        <div className="sb-editor-thread-list" aria-hidden="true">
          <div>
            <i />
            Keep reviews available offline
          </div>
          <div>
            <i />
            Check the release candidate
          </div>
          <div>
            <i />
            Improve keyboard navigation
          </div>
        </div>
      )}
      <div className="sb-editor-nav-footer" aria-hidden="true">
        ⚙ <span>Settings</span>
        <small>Design MacBook</small>
      </div>
    </aside>
  );
}

function Header({ title }: { title: string }) {
  return (
    <div className="sb-editor-header" aria-hidden="true">
      <span>{title}</span>
      <span className="sb-editor-header-actions">
        ↗<span>⋯</span>
      </span>
    </div>
  );
}

function Composer({ children }: { children?: ReactNode }) {
  return (
    <div className="sb-editor-composer">
      {children}
      <div className="sb-editor-draft" aria-hidden="true">
        Ask a follow-up…
      </div>
      <div className="sb-editor-composer-footer" aria-hidden="true">
        <span>＋</span>
        <span>Codex</span>
        <span>Default</span>
        <span>Atlas / frontend</span>
        <b>↑</b>
      </div>
    </div>
  );
}

function Conversation({ children }: { children?: ReactNode }) {
  return (
    <div className="sb-editor-conversation">
      <div className="sb-editor-user" aria-hidden="true">
        Keep the review available while the checkout reconnects.
      </div>
      <div className="sb-editor-assistant">
        <div className="sb-editor-author" aria-hidden="true">
          ✦ <span>Codex</span>
        </div>
        <p aria-hidden="true">
          The last successful snapshot stays visible while the host reconnects. Here is the current
          work for review.
        </p>
        {children}
      </div>
    </div>
  );
}

function FrameBody({
  context,
  thread,
  slot,
}: {
  context: EditorContext;
  thread: boolean;
  slot: ReactNode;
}) {
  if (context.placement === "settings")
    return (
      <div className="sb-editor-settings">
        <div className="sb-editor-settings-nav" aria-hidden="true">
          <strong>Settings</strong>
          <span>General</span>
          <span>Appearance</span>
          <span>Providers</span>
          <span>Extensions</span>
          <b>Agent instructions</b>
        </div>
        <section className="sb-editor-settings-body">
          <div className="sb-editor-section-heading" aria-hidden="true">
            <div className="sb-editor-heading">{context.title}</div>
            <p>
              Rules appended to agent instructions. Changes apply when an agent session next starts.
            </p>
          </div>
          {slot}
        </section>
      </div>
    );
  if (context.placement === "dialog")
    return (
      <>
        <div className="sb-editor-timeline" aria-hidden="true">
          <Conversation />
        </div>
        <Composer />
        <div className="sb-editor-dialog-backdrop">
          <div className="sb-editor-visualization">
            <div className="sb-editor-visualization-preview" aria-hidden="true">
              <div className="sb-editor-heading">Release progress</div>
              <p>Completed review checks this week</p>
              <div className="sb-editor-chart">
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
              <small>Illustrative preview · controls are interactive</small>
            </div>
            <div className="sb-editor-tweaks">{slot}</div>
          </div>
        </div>
      </>
    );
  if (thread)
    return (
      <>
        <div className="sb-editor-timeline">
          <Conversation>
            {["message", "overlay"].includes(context.placement) ? slot : null}
          </Conversation>
        </div>
        <Composer>{context.placement === "composer" ? slot : null}</Composer>
      </>
    );
  if (context.placement === "page-panel")
    return (
      <div className="sb-editor-page-context" aria-hidden="true">
        <span>▤</span>
        <div className="sb-editor-heading">
          {context.title === "Docs" ? "Offline review recovery" : "Review tool instructions"}
        </div>
        <p>
          {context.title === "Docs"
            ? "Keep the selected file, scroll position, and draft comment available while a checkout reconnects."
            : "Browse the plugin’s tools, prompts, and skills in the Plugins panel."}
        </p>
      </div>
    );
  return <section className="sb-editor-page">{slot}</section>;
}

/** Only the surrounding chrome is a fixture; children are production plugin components. */
export function EditorFrame({
  context,
  children,
  width,
}: {
  context: EditorContext;
  children: ReactNode;
  width: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [availableWidth, setAvailableWidth] = useState(1400);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const panelMaximum = Math.max(280, availableWidth - 285);
  const panelWidth = Math.min(
    sizes[width] ?? { narrow: 360, medium: 640, wide: 900 }[width] ?? 640,
    panelMaximum,
  );
  const setPanelWidth = (value: number) =>
    setSizes((previous) => ({ ...previous, [width]: value }));
  const [panelClosed, setPanelClosed] = useState(false);
  const reopenButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const focusPending = useRef(false);
  const togglePanel = (closed: boolean) => {
    focusPending.current = true;
    setPanelClosed(closed);
  };
  useLayoutEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    (panelClosed ? reopenButton.current : closeButton.current)?.focus();
  }, [panelClosed]);
  const panel = context.placement === "thread-panel" || context.placement === "page-panel";
  const thread = ["thread-panel", "message", "composer", "sidebar", "dialog", "overlay"].includes(
    context.placement,
  );
  const slot = (
    <div className="sb-editor-slot" data-storybook-component="">
      {children}
    </div>
  );
  const clamp = (value: number) => Math.max(280, Math.min(value, panelMaximum));
  const style: CSSProperties & { "--sb-panel-width": string } = {
    "--sb-panel-width": `${panelWidth}px`,
  };
  return (
    <div
      className="sb-editor"
      data-placement={context.placement}
      data-panel-closed={panelClosed}
      style={style}
    >
      <div className="sb-editor-note">
        BB editor context <span>· {context.placement.replaceAll("-", " ")}</span>
        <small>Preview chrome · real plugin content</small>
      </div>
      <div className="sb-editor-window">
        <Navigation title={thread ? "Threads" : context.title}>
          {context.placement === "sidebar" ? slot : null}
        </Navigation>
        <div className="sb-editor-content-row" ref={row}>
          <main className="sb-editor-main">
            <Header title={thread ? "Keep reviews available offline" : context.title} />
            {panel && panelClosed && (
              <button
                type="button"
                className="sb-editor-reopen"
                ref={reopenButton}
                onClick={() => togglePanel(false)}
              >
                Open {context.tab}
              </button>
            )}
            <FrameBody context={context} thread={thread} slot={slot} />
          </main>
          {panel && (
            <>
              {/* A focusable window splitter, not a static horizontal rule. */}
              <div
                role="separator"
                className="sb-editor-divider"
                hidden={panelClosed}
                aria-label="Resize preview panel"
                aria-orientation="vertical"
                aria-valuemin={280}
                aria-valuemax={panelMaximum}
                aria-valuenow={panelWidth}
                tabIndex={0}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.currentTarget.focus();
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId) && row.current)
                    setPanelWidth(clamp(row.current.getBoundingClientRect().right - event.clientX));
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    setPanelWidth(clamp(panelWidth + (event.key === "ArrowLeft" ? 32 : -32)));
                  }
                }}
              />
              <aside
                className="sb-editor-panel"
                hidden={panelClosed}
                aria-label={`${context.title} preview panel`}
              >
                <div className="sb-editor-panel-tabs">
                  <span aria-hidden="true">▤</span>
                  <strong>{context.tab}</strong>
                  <button
                    type="button"
                    aria-label="Close preview panel"
                    ref={closeButton}
                    onClick={() => togglePanel(true)}
                  >
                    ×
                  </button>
                </div>
                <div className="sb-editor-panel-body">{slot}</div>
              </aside>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
