// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISCLOSURE_TIMING, SlidingDisclosure } from "./SlidingDisclosure.tsx";

interface PlayedAnimation {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  finish: () => void;
}

let played: PlayedAnimation[] = [];
let frames: (FrameRequestCallback | null)[] = [];

/** Runs the callbacks the next animation frame would, as the browser does before it paints. */
function nextFrame() {
  const pending = frames;
  frames = [];
  for (const callback of pending) callback?.(0);
}

beforeEach(() => {
  played = [];
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames[id - 1] = null;
  });
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  HTMLElement.prototype.animate = vi.fn(function animate(
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ) {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    played.push({ keyframes, options, finish });
    return { finished, cancel: vi.fn() } as unknown as Animation;
  }) as unknown as HTMLElement["animate"];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Rows({ open }: { open: boolean }) {
  return (
    <SlidingDisclosure open={open}>
      <div data-sidebar-sticky-tier="parent" data-sidebar-windowed-nav="thr_row">
        <a href="/thread" id="row-link" data-sidebar-thread-id="thr_row">
          Row
        </a>
      </div>
    </SlidingDisclosure>
  );
}

describe("SlidingDisclosure", () => {
  it("shows rows that mount open without playing a reveal", () => {
    render(<Rows open />);
    expect(screen.getByRole("link", { name: "Row" })).toBeTruthy();
    expect(played).toEqual([]);
  });

  it("drops the rows at once and slides an inert copy of them closed", async () => {
    const { rerender, container } = render(<Rows open />);
    rerender(<Rows open={false} />);

    const panel = container.querySelector<HTMLElement>("[data-gtd-disclosure]")!;
    expect(screen.queryByRole("link", { name: "Row" })).toBeNull();
    const copy = panel.firstElementChild as HTMLElement & { inert: boolean };
    expect(copy.inert).toBe(true);
    // The copy keeps what styles the rows and drops what names them.
    expect(copy.querySelector("[data-sidebar-sticky-tier='parent']")).not.toBeNull();
    expect(
      copy.querySelector("[data-sidebar-thread-id], [data-sidebar-windowed-nav], #row-link"),
    ).toBeNull();
    expect(played).toHaveLength(1);
    expect(played[0]?.options).toEqual(DISCLOSURE_TIMING);
    expect(played[0]?.keyframes.at(-1)).toMatchObject({
      height: "0px",
      opacity: 0,
      filter: "blur(2px)",
    });

    await act(async () => played[0]?.finish());
    expect(panel.childElementCount).toBe(0);
    expect(panel.getAttribute("aria-hidden")).toBe("true");
  });

  it("slides reopened rows in from a blur", () => {
    const { rerender } = render(<Rows open={false} />);
    rerender(<Rows open />);
    expect(screen.getByRole("link", { name: "Row" })).toBeTruthy();
    nextFrame();
    expect(played).toHaveLength(1);
    expect(played[0]?.keyframes[0]).toMatchObject({
      height: "0px",
      filter: "blur(2px)",
      maskSize: "100% 100%",
    });
    // The edge fade leaves below the panel as it lands, so the last row
    // reaches full opacity with the slide rather than after it.
    expect(played[0]?.keyframes.at(-1)).toMatchObject({
      opacity: 1,
      filter: "blur(0px)",
      maskSize: "100% calc(100% + 16px)",
    });
  });

  it("shows rows at once when focus reaches them before the slide starts", () => {
    const { rerender, container } = render(<Rows open={false} />);
    rerender(<Rows open />);
    const panel = container.querySelector<HTMLElement>("[data-gtd-disclosure]")!;
    expect(panel.style.height).toBe("0px");
    screen.getByRole("link", { name: "Row" }).focus();
    expect(panel.style.height).toBe("");
    expect(panel.style.overflow).toBe("");
    nextFrame();
    expect(played).toEqual([]);
  });

  it("lands the opening slide on the height the rows settle at", () => {
    const { rerender, container } = render(<Rows open={false} />);
    const panel = container.querySelector<HTMLElement>("[data-gtd-disclosure]")!;
    // The windowed list mounts 30px placeholders, then swaps in 28px rows in
    // a follow-up render; a guide or shield below the last row overhangs it.
    let rowsHeight = 30;
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 32 });
    vi.spyOn(panel, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, 300, panel.style.height === "0px" ? 0 : rowsHeight),
    );
    rerender(<Rows open />);
    // Until the frame, the panel holds where the slide starts.
    expect(panel.style.height).toBe("0px");
    rowsHeight = 28;
    nextFrame();
    expect(played[0]?.keyframes.at(-1)).toMatchObject({ height: "28px" });
    // Margins at its edges stay inside, so open and folded heights hold.
    expect(panel.style.display).toBe("flow-root");
  });

  it("drops a pending open when the rows fold again first", () => {
    const { rerender, container } = render(<Rows open={false} />);
    rerender(<Rows open />);
    rerender(<Rows open={false} />);
    nextFrame();
    expect(played).toHaveLength(1);
    expect(played[0]?.keyframes.at(-1)).toMatchObject({ height: "0px", opacity: 0 });
    expect(container.querySelector("[data-gtd-disclosure]")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("only fades when the user asks for reduced motion", () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const { rerender } = render(<Rows open />);
    rerender(<Rows open={false} />);
    expect(played[0]?.keyframes.every((frame) => !("height" in frame))).toBe(true);
  });
});
