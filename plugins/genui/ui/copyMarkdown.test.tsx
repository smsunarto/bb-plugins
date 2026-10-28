// @vitest-environment jsdom
// "Copy as markdown" under a reply's ```ui block: what lands on the clipboard
// is the block's markdown with the values the user moved, not the spec's.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { specToMarkdown } from "../core";
import { Frame } from "./LiveUi";
import { SlotFence } from "./SlotFence";

declare const jsdom: { window: Window };

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  useComposers: () => [],
  useSdk: () => ({ threads: { send: vi.fn() } }),
  useBbNavigate: () => ({}),
  useRpc: () => ({ call: vi.fn() }),
  useSettings: () => ({ values: { animations: false }, isLoading: false }),
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
  experimental_Icon: () => <span aria-hidden="true" />,
}));
vi.mock("./useSuperseded", () => ({ useSuperseded: () => false, useReplyIndex: () => 0 }));

const FORM = (formats: string) => `$formats = ${formats}
Card("Export", [Checklist($formats, ["CSV", "JSON", "XLSX"], label: "Which formats?")])`;

let writeText: Mock<(text: string) => Promise<void>>;
let thread = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("CSS", { supports: () => false });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
  localStorage.clear();
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  toast.success.mockClear();
  toast.error.mockClear();
  thread++;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mountUi(code: string): HTMLElement {
  const message = { id: `thr_${thread}:assistant:1`, threadId: `thr_${thread}`, turnId: "turn", projectId: "project" };
  return render(<SlotFence language="ui" status="closed" code={code} index={0} message={message} Original={() => <pre />} />).container;
}

describe("copying a ui block as markdown", () => {
  it("copies the block as it reads now, with the user's picks", async () => {
    const block = mountUi(FORM("[]"));
    fireEvent.click(within(block).getByRole("checkbox", { name: "JSON" }));
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "Copy as markdown" }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0];
    expect(copied).toBe(specToMarkdown(FORM('["JSON"]')));
    expect(copied).not.toBe(specToMarkdown(FORM("[]")));
    expect(toast.success).toHaveBeenCalledWith("Copied as markdown");
  });

  it("says so when the clipboard refuses", async () => {
    writeText.mockRejectedValueOnce(new Error("Write permission denied."));
    const block = mountUi(FORM("[]"));
    await act(async () => {
      fireEvent.click(within(block).getByRole("button", { name: "Copy as markdown" }));
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy as markdown: Write permission denied.");
  });

  it("is not offered for an html app", () => {
    render(
      <Frame source="<p>hi</p>" language="html" diagnostics={[]}>
        <p>app</p>
      </Frame>,
    );
    expect(screen.getByRole("button", { name: "Source" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy as markdown" })).toBeNull();
  });
});
