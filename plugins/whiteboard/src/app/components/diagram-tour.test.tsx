// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewDebugSettingsProvider } from "../vendor/review/app/src/debug-settings.tsx";
import { ReviewSessionProvider } from "../vendor/review/app/src/host/review-session.tsx";
import { ReviewProvider } from "../vendor/review/app/src/review-context.tsx";
import { ReviewPanelProvider } from "../vendor/review/app/src/review-panel.tsx";
import type { GuidedTour } from "../vendor/review/app/src/review-panel-model.ts";
import {
  ReviewContainerProvider,
  ReviewRootsProvider,
} from "../vendor/review/app/src/review-root-context.tsx";
import { testReviewSession } from "../vendor/review/app/src/review-session-test-utils.tsx";
import { DiagramTourOverlay, useDiagramTourShell } from "./diagram-tour.tsx";

afterEach(cleanup);

const tour: GuidedTour = {
  id: "flow",
  title: "Ambient loop",
  stops: [
    {
      anchor: { id: "flow:tick", title: "Detector tick" },
      label: "Detector tick",
      content: { kind: "explanation", text: "This node has no code attachments." },
    },
    {
      anchor: { id: "flow:gate", title: "Under budget?" },
      label: "Under budget?",
      content: { kind: "explanation", text: "This node has no code attachments." },
    },
  ],
};

/**
 * The canvas root as panel/mount.tsx renders it (focusable, the portal
 * target, the theme host inside), with App.tsx's roots around `.review-app`.
 */
function Canvas({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const appRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const scrollRegionRef = useRef<HTMLElement | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  return (
    <ReviewSessionProvider session={testReviewSession()}>
      <ReviewProvider>
        <ReviewDebugSettingsProvider>
          <ReviewPanelProvider>
            <div
              ref={setRoot}
              className="review-canvas-root"
              data-review-theme="dark"
              tabIndex={-1}
            >
              <div className="review-theme-host">
                {root ? (
                  <ReviewContainerProvider container={root}>
                    <ReviewRootsProvider roots={{ appRef, shellRef, scrollRegionRef, articleRef }}>
                      <div ref={appRef} className="review-app">
                        {children}
                      </div>
                    </ReviewRootsProvider>
                  </ReviewContainerProvider>
                ) : null}
              </div>
            </div>
          </ReviewPanelProvider>
        </ReviewDebugSettingsProvider>
      </ReviewProvider>
    </ReviewSessionProvider>
  );
}

/** A diagram the way flow-diagram.tsx wires the shell: inline Expand, overlay portaled to the root. */
function ExpandableDiagram({
  onClose,
  tourData = true,
  restored = false,
}: {
  onClose: () => void;
  /** database-lens.tsx drops the overlay when its tour data goes away, with `open` still set. */
  tourData?: boolean;
  /** useTourRestore in diagrams.tsx and database-lens.tsx reopens a tour on mount. */
  restored?: boolean;
}) {
  const [open, setOpen] = useState(restored);
  const close = useCallback(() => {
    onClose();
    setOpen(false);
  }, [onClose]);
  const { overlayRef, portalTarget, paneResize } = useDiagramTourShell(open, close);

  return (
    <>
      <button type="button" className="diagram-tour-button" onClick={() => setOpen(true)}>
        Expand
      </button>
      {open && tourData && portalTarget
        ? createPortal(
            <DiagramTourOverlay
              className="diagram-tour-overlay--flow"
              tour={tour}
              activeAnchor="flow:tick"
              revealRequest={1}
              paneWidth={paneResize.width}
              separatorProps={paneResize.separatorProps}
              overlayRef={overlayRef}
              onActiveAnchorChange={() => {}}
              onClose={close}
            >
              <figure>Stage</figure>
            </DiagramTourOverlay>,
            portalTarget,
          )
        : null}
    </>
  );
}

function openTour() {
  const onClose = vi.fn();
  const { container } = render(
    <Canvas>
      <ExpandableDiagram onClose={onClose} />
    </Canvas>,
  );
  const expand = screen.getByRole("button", { name: "Expand" });
  expand.focus();
  fireEvent.click(expand);
  const host = container.querySelector(".review-theme-host")!;
  return { onClose, expand, host, dialog: screen.getByRole("dialog") };
}

it("covers the document and moves focus to the active step's heading", () => {
  const { host, dialog } = openTour();

  expect(host.hasAttribute("inert")).toBe(true);
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.activeElement?.tagName).toBe("H3");
  expect(document.activeElement?.textContent).toBe("Detector tick");
});

it("closes on Escape inside the tour and returns focus to Expand", () => {
  const { onClose, expand, host, dialog } = openTour();

  fireEvent.keyDown(dialog, { key: "Escape" });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(host.hasAttribute("inert")).toBe(false);
  expect(document.activeElement).toBe(expand);
});

it("ignores Escape typed in bb's composer", () => {
  const composer = document.body.appendChild(document.createElement("textarea"));
  const { onClose } = openTour();
  composer.focus();

  fireEvent.keyDown(composer, { key: "Escape" });

  expect(onClose).toHaveBeenCalledTimes(0);
  expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Ambient loop tour");
  composer.remove();
});

it("leaves focus in bb's chrome when the tour opens and closes while the reader is outside the canvas", () => {
  const composer = document.body.appendChild(document.createElement("textarea"));
  const onClose = vi.fn();
  const { container } = render(
    <Canvas>
      <ExpandableDiagram onClose={onClose} />
    </Canvas>,
  );
  composer.focus();

  fireEvent.click(screen.getByRole("button", { name: "Expand" }));

  expect(container.querySelector(".review-theme-host")!.hasAttribute("inert")).toBe(true);
  expect(document.activeElement).toBe(composer);

  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(composer);
  composer.remove();
});

it("uncovers the document when the overlay goes away while the tour is still open", () => {
  const onClose = vi.fn();
  const { container, rerender } = render(
    <Canvas>
      <ExpandableDiagram onClose={onClose} />
    </Canvas>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  const host = container.querySelector(".review-theme-host")!;
  expect(host.hasAttribute("inert")).toBe(true);

  rerender(
    <Canvas>
      <ExpandableDiagram onClose={onClose} tourData={false} />
    </Canvas>,
  );

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(host.hasAttribute("inert")).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
});

it("focuses the canvas, not another diagram, when a tour restored on mount closes", () => {
  const onClose = vi.fn();
  const { container } = render(
    <Canvas>
      <ExpandableDiagram onClose={vi.fn()} />
      <ExpandableDiagram onClose={onClose} restored />
    </Canvas>,
  );

  expect(document.activeElement?.textContent).toBe("Detector tick");

  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(container.querySelector(".review-canvas-root"));
});

it("focuses the canvas, not bb's composer, when the reader steps into a tour restored behind the composer and closes it", () => {
  const composer = document.body.appendChild(document.createElement("textarea"));
  composer.focus();
  const { container } = render(
    <Canvas>
      <ExpandableDiagram onClose={vi.fn()} restored />
    </Canvas>,
  );
  expect(document.activeElement).toBe(composer);

  const dialog = screen.getByRole("dialog");
  dialog.focus();
  fireEvent.keyDown(dialog, { key: "Escape" });

  expect(document.activeElement).toBe(container.querySelector(".review-canvas-root"));
  composer.remove();
});
