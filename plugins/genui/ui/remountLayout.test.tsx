// @vitest-environment jsdom
// A thread opened again must lay its blocks out at their final size on the
// first frame: no placeholder that grows when a picture arrives, no choices
// that fold when the outline arrives, no reservation dropped while a picture
// is still being read (a remote BB can take seconds per picture).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SlotFence } from "./SlotFence";
import { useSuperseded } from "./useSuperseded";

const { rpc, sdk, pictures } = vi.hoisted(() => {
  // Pictures being read, by path: a test resolves one when it arrives.
  const pictures = new Map<string, (loaded: unknown) => void>();
  const rpc = {
    call: vi.fn((method: string, params: { path?: string }) =>
      method === "load_image" ? new Promise((resolve) => pictures.set(params.path ?? "", resolve)) : Promise.resolve({ ok: false, error: "not here" }),
    ),
  };
  const outlines: Record<string, { items: { id: string; role: "assistant" | "user" }[] }> = {
    hold: { items: [] },
    page: { items: [{ id: "page:assistant:1", role: "assistant" }, { id: "page:user-seed:9", role: "user" }] },
    later: { items: [{ id: "later:assistant:1", role: "assistant" }, { id: "later:user-seed:4", role: "user" }] },
  };
  const sdk = {
    subscribe: () => () => {},
    threads: {
      // "fresh" is a thread whose outline is still being read; "offline" one whose read fails.
      conversationOutline: ({ threadId }: { threadId: string }) =>
        threadId === "offline"
          ? Promise.reject(new Error("offline"))
          : threadId in outlines
            ? Promise.resolve(outlines[threadId])
            : new Promise(() => {}),
    },
  };
  return { rpc, sdk, pictures };
});

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  useComposers: () => [],
  useSdk: () => sdk,
  useBbNavigate: () => ({}),
  useRpc: () => rpc,
  useSettings: () => ({ values: { animations: true }, isLoading: false }),
  experimental_Icon: () => <span aria-hidden="true" />,
}));

let container: HTMLDivElement;
let root: Root;

/** Replies `replies` of thread `threadId`, each showing one ```ui block of `code`. */
function renderBlock(threadId: string, code: string, replies: readonly number[] = [1]): void {
  act(() =>
    root.render(
      replies.map((reply) => (
        <SlotFence
          key={reply}
          language="ui"
          status="closed"
          code={code}
          index={0}
          message={{ id: `${threadId}:assistant:${reply}`, threadId, turnId: "turn", projectId: "project" }}
          Original={() => null}
        />
      )),
    ),
  );
}

/** The browser decoding `img` at its natural size. */
function decode(img: HTMLImageElement, width: number, height: number): void {
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  act(() => {
    img.dispatchEvent(new Event("load"));
  });
}

const loadImageCalls = () => rpc.call.mock.calls.filter(([method]) => method === "load_image").length;

beforeAll(() => {
  // What an earlier page left behind; the stores read it on first use.
  localStorage.setItem("bb.genui.image-sizes", JSON.stringify([["fresh|bb.genui.state:fresh:assistant:1#ui#0|poster.png", [600, 900]]]));
  localStorage.setItem("bb.genui.answered", JSON.stringify(["fresh:assistant:answered"]));
  localStorage.setItem(
    "bb.genui.heights",
    JSON.stringify([
      ["bb.genui.state:hold:assistant:1#ui#0", [720, 500]],
      ["bb.genui.state:stuck:assistant:1#ui#0", [720, 500]],
    ]),
  );
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // The column BB lays replies out in.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 720, 0));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a block BB mounts again", () => {
  it("shows a picture this page already read, at its size, on its first frame", async () => {
    renderBlock("page", 'Image("shot.png", "Shot")');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => pictures.get("shot.png")?.({ ok: true, dataUrl: "data:image/png;base64,AAAA" }));
    decode(container.querySelector("img")!, 480, 270);

    // BB's timeline drops the row (the thread is left, or scrolled past), then mounts it again.
    act(() => root.render(null));
    renderBlock("page", 'Image("shot.png", "Shot")');
    const img = container.querySelector("img")!;
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(img.className).toContain("opacity-100");
    expect(img.parentElement?.style.aspectRatio).toBe("480 / 270");
    // As wide as the picture, so a table cell or a flex item sizing to its content keeps it.
    expect(img.parentElement?.style.width).toBe("480px");
    expect(loadImageCalls()).toBe(1);
  });

  it("reads a picture afresh for a later reply showing the same path", async () => {
    const calls = loadImageCalls();
    renderBlock("page", 'Image("retaken.png")', [1]);
    await act(async () => pictures.get("retaken.png")?.({ ok: true, dataUrl: "data:image/png;base64,T0xE" }));
    renderBlock("page", 'Image("retaken.png")', [1, 2]);
    expect(loadImageCalls()).toBe(calls + 2);
  });

  it("lets an SVG lay itself out, and remembers no size for it", async () => {
    renderBlock("page", 'Image("diagram.svg")');
    await act(async () => pictures.get("diagram.svg")?.({ ok: true, dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }));
    // What Chrome reports for an SVG with only a viewBox: not the size it is shown at.
    decode(container.querySelector("img")!, 200, 150);
    expect(container.querySelector("img")?.className).toContain("max-h-96");

    act(() => root.render(null));
    renderBlock("page", 'Image("diagram.svg")');
    expect(container.querySelector("img")?.parentElement?.style.aspectRatio ?? "").toBe("");
  });

  it("holds a picture's remembered size while a fresh page reads it", () => {
    renderBlock("fresh", 'Image("poster.png", "Poster")');
    const box = container.querySelector('[role="status"]')?.parentElement;
    expect(box?.style.aspectRatio).toBe("600 / 900");
    expect(box?.className).not.toContain("h-48");
  });

  it("keeps the height it settled at while a picture is read, past the fallback for shorter content", async () => {
    vi.useFakeTimers();
    renderBlock("hold", 'Image("late.png", "Late")');
    const holder = container.querySelector<HTMLElement>("[data-genui-fence] .group\\/genui > div");
    expect(holder?.style.minHeight).toBe("500px");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(holder?.style.minHeight).toBe("500px");

    await act(async () => pictures.get("late.png")?.({ ok: false, error: "gone" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(holder?.style.minHeight).toBe("");
  });

  it("remembers no placeholder's height while a picture it read is still decoding", async () => {
    // Laid out as the placeholder, until the picture decodes.
    const box = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 720, 192));
    renderBlock("page", 'Image("slow.png", "Slow")', [5]);
    await act(async () => pictures.get("slow.png")?.({ ok: true, dataUrl: "data:image/png;base64,U0xPVw==" }));
    act(() => root.render(null));
    // Mounted again, it is shorter for a moment; a remembered height would be held.
    box.mockReturnValue(new DOMRect(0, 0, 720, 0));
    renderBlock("page", 'Image("slow.png", "Slow")', [5]);
    expect(container.querySelector<HTMLElement>("[data-genui-fence] .group\\/genui > div")?.style.minHeight).toBe("");

    box.mockReturnValue(new DOMRect(0, 0, 720, 405));
    decode(container.querySelector("img")!, 720, 405);
    act(() => root.render(null));
    box.mockReturnValue(new DOMRect(0, 0, 720, 0));
    renderBlock("page", 'Image("slow.png", "Slow")', [5]);
    expect(container.querySelector<HTMLElement>("[data-genui-fence] .group\\/genui > div")?.style.minHeight).toBe("405px");
  });

  it("reads a picture again when its block mounts again after the picture failed to decode", async () => {
    renderBlock("page", 'Image("broken.png")', [6]);
    await act(async () => pictures.get("broken.png")?.({ ok: true, dataUrl: "data:image/png;base64,QlJPS0VO" }));
    act(() => {
      container.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(container.textContent).toContain("Couldn't load the image at broken.png");
    const calls = loadImageCalls();

    act(() => root.render(null));
    renderBlock("page", 'Image("broken.png")', [6]);
    expect(loadImageCalls()).toBe(calls + 1);
  });

  it("still ends a reservation the content no longer fills when BB's outline never arrives", async () => {
    vi.useFakeTimers();
    renderBlock("stuck", 'Text("Shorter now")');
    const holder = container.querySelector<HTMLElement>("[data-genui-fence] .group\\/genui > div");
    expect(holder?.style.minHeight).toBe("500px");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(holder?.style.minHeight).toBe("");
  });
});

describe("useSuperseded", () => {
  function Verdict({ threadId, messageId }: { threadId: string; messageId: string }) {
    return <output>{String(useSuperseded(threadId, messageId))}</output>;
  }
  const verdicts = () => [...container.querySelectorAll("output")].map((output) => output.textContent);

  it("answers at once for a reply seen answered on an earlier page, and waits for the outline for one it never saw", () => {
    act(() =>
      root.render(
        <>
          <Verdict threadId="fresh" messageId="fresh:assistant:answered" />
          <Verdict threadId="fresh" messageId="fresh:assistant:open" />
        </>,
      ),
    );
    expect(verdicts()).toEqual(["true", "null"]);
  });

  it("counts replies as unanswered when the outline can't be read, instead of leaving them provisional", async () => {
    await act(async () => root.render(<Verdict threadId="offline" messageId="offline:assistant:1" />));
    expect(verdicts()).toEqual(["false"]);
  });

  it("remembers a reply the outline shows answered", async () => {
    await act(async () => root.render(<Verdict threadId="later" messageId="later:assistant:1" />));
    expect(verdicts()).toEqual(["true"]);
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem("bb.genui.answered") ?? "[]")).toContain("later:assistant:1"));
  });
});
