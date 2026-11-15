// @vitest-environment jsdom
// A chat reply's ```ui and ```app blocks render alone: no Source toggle and no
// "Copy as markdown" under them. The gallery keeps its footer.
import { cleanup, render, screen, within } from "@testing-library/react";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "./LiveUi";
import { SlotFence } from "./SlotFence";

declare const jsdom: { window: Window };

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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

let thread = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
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
  thread++;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a reply's UI", () => {
  it("shows no Source or Copy as markdown under a ui block", () => {
    const message = {
      id: `thr_${thread}:assistant:1`,
      threadId: `thr_${thread}`,
      turnId: "turn",
      projectId: "project",
    };
    const block = render(
      <SlotFence
        language="ui"
        status="closed"
        code={`Card("Export", [Text("hi")])`}
        index={0}
        message={message}
        Original={() => <pre />}
      />,
    ).container;
    expect(within(block).getByText("hi")).toBeTruthy();
    expect(within(block).queryByRole("button", { name: /Source|Copy as markdown/ })).toBeNull();
  });

  it("shows no Source under an html app", () => {
    render(
      <Frame source="<p>hi</p>" language="html" diagnostics={[]}>
        <p>app</p>
      </Frame>,
    );
    expect(screen.getByText("app")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
  });
});
