import "./dom.ts";
import { beforeEach, expect, test } from "bun:test";
import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../src/app/query.ts";
import type { ChangedFile } from "../src/shared/schema.ts";
import { pullRequest as pr } from "./app-fixtures.ts";

const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { DiffFile } = await import("../src/app/diff-file.tsx");

beforeEach(() => {
  queryClient.clear();
});

function changed(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: "src/login.ts",
    previousPath: null,
    status: "modified",
    additions: 2,
    deletions: 1,
    viewed: "unviewed",
    generated: false,
    patch: "@@ -1,3 +1,4 @@\n import a\n-const b = 1;\n+const b = 2;\n+const c = 3;\n export {};",
    ...overrides,
  };
}

type Call = { method: string; input: unknown };
type Shown = { file: ChangedFile; headRefOid: string; baseRefName: string };

/**
 * One open file card, with line 3 of the head selected so its gutter "+"
 * is drawn. `show` swaps the file, head, and base, as a push or a retarget
 * read again does.
 */
function mount(first: Shown, calls: Call[] = []) {
  let show: (next: Shown) => void = () => {};
  const focus = { line: 3, side: "RIGHT" as const };
  const View = () => {
    const [shown, setShown] = useState(first);
    show = setShown;
    return (
      <QueryClientProvider client={queryClient}>
        <DiffFile
          pr={pr}
          file={shown.file}
          headRefOid={shown.headRefOid}
          baseRefName={shown.baseRefName}
          threads={[]}
          findings={[]}
          findingsStale={false}
          open
          diffStyle="unified"
          focus={focus}
          onOpenChange={() => {}}
          onViewedChange={() => {}}
        />
      </QueryClientProvider>
    );
  };
  const rpc = {
    addDraftComment: (input: unknown) => {
      calls.push({ method: "addDraftComment", input });
      return { threadId: "TNEW", commentId: "CNEW" };
    },
    pullRequest: () => pr,
    inbox: () => ({ viewer: "scott", assigned: [], team: [], authored: [], pinned: [] }),
  };
  const slot = renderSlot({ component: View }, {}, { rpc: rpc as never });
  return { slot, show: (next: Shown) => act(() => show(next)) };
}

/** Presses the gutter "+" on the selected line, as a pointer does. */
async function pressPlus(container: HTMLElement) {
  const plus = await waitFor(() => {
    const host = [...container.querySelectorAll("*")].find((element) => element.shadowRoot);
    const button = host?.shadowRoot?.querySelector("[data-utility-button]");
    if (!button) throw new Error("no gutter + yet");
    return button;
  });
  fireEvent.pointerDown(plus, { button: 0 });
  fireEvent.pointerUp(document);
}

test("a new comment is sent with the head and base its lines were picked in", async () => {
  const calls: Call[] = [];
  const { slot } = mount({ file: changed(), headRefOid: "h1", baseRefName: "main" }, calls);
  await pressPlus(slot.container);

  const box = await slot.findByRole("textbox", { name: "Comment on line 3 of src/login.ts" });
  fireEvent.change(box, { target: { value: "Why three?" } });
  fireEvent.click(slot.getByRole("button", { name: "Add review comment" }));

  await waitFor(() =>
    expect(calls).toEqual([
      {
        method: "addDraftComment",
        input: {
          account: "scott",
          pullRequestId: "PR_kwDOA42",
          headRefOid: "h1",
          baseRefName: "main",
          path: "src/login.ts",
          body: "Why three?",
          line: 3,
          startLine: null,
          side: "RIGHT",
          startSide: null,
        },
      },
    ]),
  );
  slot.lifecycle.unmount();
});

test("after a push, an open comment keeps its text and saves only once its lines are picked again", async () => {
  const calls: Call[] = [];
  const { slot, show } = mount({ file: changed(), headRefOid: "h1", baseRefName: "main" }, calls);
  await pressPlus(slot.container);
  const box = await slot.findByRole("textbox", { name: "Comment on line 3 of src/login.ts" });
  fireEvent.change(box, { target: { value: "Why three?" } });

  // The push adds a line on top, so head line 3 now holds other code.
  show({
    file: changed({
      additions: 3,
      patch:
        "@@ -1,3 +1,5 @@\n+// rate limit\n import a\n-const b = 1;\n+const b = 2;\n+const c = 3;\n export {};",
    }),
    headRefOid: "h2",
    baseRefName: "main",
  });

  const submit = slot.getByRole("button", { name: "Add review comment" }) as HTMLButtonElement;
  expect(slot.getByRole("status").textContent).toBe(
    "This pull request has changed since you picked these lines. Pick them again in the diff to save this comment. Your text is kept.",
  );
  expect((slot.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Why three?");
  expect(submit.disabled).toBe(true);
  fireEvent.keyDown(slot.getByRole("textbox"), { key: "Enter", ctrlKey: true });
  expect(calls).toEqual([]);

  // Picking the line again counts it in the new head, and the text comes along.
  await pressPlus(slot.container);
  await waitFor(() => expect(slot.queryByRole("status")).toBeNull());
  expect((slot.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Why three?");
  fireEvent.click(slot.getByRole("button", { name: "Add review comment" }));
  await waitFor(() =>
    expect(calls.map((call) => call.input)).toEqual([
      expect.objectContaining({ headRefOid: "h2", line: 3, body: "Why three?" }),
    ]),
  );
  slot.lifecycle.unmount();
});

test("after a retarget, an open comment keeps its text and saves only once its lines are picked again", async () => {
  const calls: Call[] = [];
  const { slot, show } = mount({ file: changed(), headRefOid: "h1", baseRefName: "main" }, calls);
  await pressPlus(slot.container);
  const box = await slot.findByRole("textbox", { name: "Comment on line 3 of src/login.ts" });
  fireEvent.change(box, { target: { value: "Why three?" } });

  // Retargeted: the head stays, and the base side now counts another branch's lines.
  show({
    file: changed({
      deletions: 2,
      patch:
        "@@ -1,4 +1,4 @@\n import a\n-const a = 0;\n-const b = 1;\n+const b = 2;\n+const c = 3;\n export {};",
    }),
    headRefOid: "h1",
    baseRefName: "release",
  });

  const submit = slot.getByRole("button", { name: "Add review comment" }) as HTMLButtonElement;
  expect(slot.getByRole("status").textContent).toBe(
    "This pull request has changed since you picked these lines. Pick them again in the diff to save this comment. Your text is kept.",
  );
  expect((slot.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Why three?");
  expect(submit.disabled).toBe(true);
  fireEvent.keyDown(slot.getByRole("textbox"), { key: "Enter", ctrlKey: true });
  expect(calls).toEqual([]);

  await pressPlus(slot.container);
  await waitFor(() => expect(slot.queryByRole("status")).toBeNull());
  expect((slot.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Why three?");
  fireEvent.click(slot.getByRole("button", { name: "Add review comment" }));
  await waitFor(() =>
    expect(calls.map((call) => call.input)).toEqual([
      expect.objectContaining({ headRefOid: "h1", baseRefName: "release", body: "Why three?" }),
    ]),
  );
  slot.lifecycle.unmount();
});

test("a diff not yet in view holds the height of the rows it will draw", () => {
  // Never in view, so the diff stays a placeholder.
  const real = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    observe(): void {}
    disconnect(): void {}
  } as unknown as typeof IntersectionObserver;
  try {
    const { slot } = mount({
      file: changed({
        additions: 3,
        deletions: 2,
        patch: [
          "@@ -1,4 +1,5 @@",
          " import a",
          "-const b = 1;",
          "+const b = 2;",
          "+const c = 3;",
          " ",
          " export {};",
          "@@ -20,3 +21,3 @@ function tail() {",
          " one",
          "-two",
          "+TWO",
          " three",
        ].join("\n"),
      }),
      headRefOid: "h1",
      baseRefName: "main",
    });
    const placeholder = slot.container.querySelector<HTMLElement>('div[aria-hidden="true"]');
    // 10 drawn rows of 20px, and one 32px separator for the 15 folded lines
    // between the hunks, which are never drawn.
    expect(placeholder?.style.height).toBe("232px");
    slot.lifecycle.unmount();
  } finally {
    globalThis.IntersectionObserver = real;
  }
});

test("a rename GitHub sends no diff for still links to GitHub, since it may be binary", async () => {
  const { slot } = mount({
    file: changed({
      path: "assets/logo-v2.png",
      previousPath: "assets/logo.png",
      status: "renamed",
      additions: 0,
      deletions: 0,
      patch: null,
    }),
    headRefOid: "h1",
    baseRefName: "main",
  });
  const link = await slot.findByRole("link", { name: "View on GitHub" });
  expect(link.parentElement?.textContent).toBe(
    "Renamed from assets/logo.png. GitHub sends no diff for it, so only its name changed, or it is binary. View on GitHub",
  );
  slot.lifecycle.unmount();
});
