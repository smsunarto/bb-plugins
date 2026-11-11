// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { changeKeySchema } from "../../core/ids.ts";
import { reviewPath, type ChangeDetail, type ChangeRow } from "../../core/review.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import { ReviewPanel as ReviewPage } from "../review-entry.tsx";
import { resetNavStores } from "./sources.ts";
import { resetPatchStores } from "./patches.ts";

const KEY = changeKeySchema.parse("gh:smsunarto/bb-plugins:smsunarto:scott/forge-host");

const ROW: ChangeRow = {
  key: KEY,
  repo: "smsunarto/bb-plugins",
  title: "Route gh through the checkout host",
  branch: "scott/forge-host",
  baseRef: "main",
  number: 482,
  url: null,
  author: "smsunarto",
  state: "open",
  mine: true,
  asked: false,
  stack: null,
  hostId: "host-a",
  line: "",
  chips: [],
  sort: 6,
  updatedAt: new Date().toISOString(),
};

function detail(overrides: Partial<Extract<ChangeDetail, { state: "change" }>> = {}): ChangeDetail {
  return {
    state: "change",
    row: ROW,
    head: "c0ffee",
    files: 0,
    additions: 0,
    deletions: 0,
    revision: { head: "c0ffee", base: "aaa111", source: { kind: "forge", number: 482 } },
    stack: null,
    canMarkReady: false,
    ship: [],
    status: { label: "Open", tone: "open", number: 482, noPullRequest: false },
    problem: null,
    at: Date.now(),
    ...overrides,
  };
}

type Handlers = PluginRpcTestHandlers<typeof sourceControlContract>;

function render(rpc: Partial<Handlers>) {
  return renderSlot(
    { component: ReviewPage },
    { subPath: reviewPath({ key: KEY }) },
    {
      experimental_rpcContract: sourceControlContract,
      pluginId: "source-control",
      rpc: {
        changeDetail: ({ keys }) => Object.fromEntries(keys.map((k) => [k, detail()])),
        checksForChange: ({ keys }) =>
          Object.fromEntries(keys.map((k) => [k, { read: null, problem: null }])),
        changeFiles: () => ({ ok: true as const, files: [], more: false }),
        changeCommits: () => ({ ok: true as const, commits: [], more: false }),
        askForChange: ({ keys }) => Object.fromEntries(keys.map((k) => [k, { threadId: null }])),
        ...rpc,
      } as Handlers,
    },
  );
}

const panelOf = (slot: ReturnType<typeof render>) =>
  slot.getByTestId("sc-ask-panel") as HTMLDialogElement;

beforeEach(() => {
  resetNavStores();
  resetPatchStores();
});
afterEach(cleanup);

test("nothing mounts or is asked until the first open; the panel opens on the composer and stays mounted when closed", async () => {
  const asked: unknown[] = [];
  const slot = render({
    ask: (input) => {
      asked.push(input);
      return { ok: true, threadId: "ask-1" };
    },
  });
  const trigger = await slot.findByTestId("sc-ask-agent");
  expect(slot.queryByTestId("sc-ask-panel")).toBeNull();
  fireEvent.click(trigger);
  const panel = panelOf(slot);
  expect(panel.open).toBe(true);
  expect(panel.getAttribute("aria-label")).toBe("Ask about #482");
  expect(document.activeElement).toBe(slot.getByRole("textbox", { name: "Question" }));
  fireEvent.click(slot.getByRole("button", { name: "Close" }));
  expect(panelOf(slot).open).toBe(false);
  expect(document.activeElement).toBe(trigger);
  expect(asked).toEqual([]);
});

test("Escape closes the panel without reaching the page, and focus returns to the trigger", async () => {
  const slot = render({});
  const trigger = await slot.findByTestId("sc-ask-agent");
  // bb's own Escape ("Back to app") listens on the window.
  let pageSawEscape = 0;
  const onWindowKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") pageSawEscape += 1;
  };
  window.addEventListener("keydown", onWindowKey);
  try {
    fireEvent.click(trigger);
    const textarea = slot.getByRole("textbox", { name: "Question" });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(panelOf(slot).open).toBe(false);
    expect(pageSawEscape).toBe(0);
    expect(document.activeElement).toBe(trigger);
    // The page is still there.
    expect(slot.getByTestId("sc-review-title")).toBeTruthy();
  } finally {
    window.removeEventListener("keydown", onWindowKey);
  }
});

test("a typed question survives close and reopen; sending it once shows the Ask thread", async () => {
  const asked: unknown[] = [];
  let threadId: string | null = null;
  const slot = render({
    askForChange: ({ keys }) => Object.fromEntries(keys.map((k) => [k, { threadId }])),
    ask: (input) => {
      asked.push(input);
      threadId = "ask-1";
      return { ok: true, threadId: "ask-1" };
    },
  });
  const trigger = await slot.findByTestId("sc-ask-agent");
  fireEvent.click(trigger);
  fireEvent.change(slot.getByRole("textbox", { name: "Question" }), {
    target: { value: "Why the account?" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Close" }));
  fireEvent.click(trigger);
  const textarea = slot.getByRole("textbox", { name: "Question" }) as HTMLTextAreaElement;
  expect(textarea.value).toBe("Why the account?");
  await act(async () => {
    fireEvent.click(slot.getByRole("button", { name: "Send question" }));
  });
  expect(asked).toEqual([{ key: KEY, text: "Why the account?" }]);
  const chat = await slot.findByTestId("bb-thread-chat");
  expect(chat.getAttribute("data-thread-id")).toBe("ask-1");
  expect(chat.getAttribute("data-variant")).toBe("compact");
  // Each open asks ThreadChat to focus its composer.
  const before = Number(chat.getAttribute("data-focus-request"));
  fireEvent.click(slot.getByRole("button", { name: "Close" }));
  fireEvent.click(trigger);
  expect(Number(slot.getByTestId("bb-thread-chat").getAttribute("data-focus-request"))).toBe(
    before + 1,
  );
});

test("with the owning thread's host away, the panel shows the conversation and says why sending waits", async () => {
  const away = detail({
    revision: {
      head: "c0ffee",
      base: "aaa111",
      source: { kind: "host", hostId: "host-a", path: "/Users/scott/bb-plugins" },
    },
    problem: { kind: "host-offline", host: "studio-mac" },
  });
  let calls = 0;
  const slot = render({
    changeDetail: ({ keys }) => Object.fromEntries(keys.map((k) => [k, away])),
    askForChange: ({ keys }) => {
      calls += 1;
      return Object.fromEntries(keys.map((k) => [k, { threadId: "ask-1" }]));
    },
  });
  fireEvent.click(await slot.findByTestId("sc-ask-agent"));
  expect((await slot.findByTestId("bb-thread-chat")).getAttribute("data-thread-id")).toBe("ask-1");
  expect(slot.getByTestId("sc-ask-offline").textContent).toBe(
    "studio-mac is not answering, so questions wait until it is back.",
  );
  // One read, no retry loop.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(calls).toBe(1);
});

test("before the Ask thread exists, a host away disables the first question", async () => {
  const away = detail({
    revision: {
      head: "c0ffee",
      base: "aaa111",
      source: { kind: "host", hostId: "host-a", path: "/Users/scott/bb-plugins" },
    },
    problem: { kind: "host-offline", host: "studio-mac" },
  });
  const slot = render({
    changeDetail: ({ keys }) => Object.fromEntries(keys.map((k) => [k, away])),
  });
  fireEvent.click(await slot.findByTestId("sc-ask-agent"));
  fireEvent.change(slot.getByRole("textbox", { name: "Question" }), {
    target: { value: "Still there?" },
  });
  await waitFor(() => expect(slot.getByTestId("sc-ask-offline")).toBeTruthy());
  expect(slot.getByRole("button", { name: "Send question" })).toHaveProperty("disabled", true);
});
