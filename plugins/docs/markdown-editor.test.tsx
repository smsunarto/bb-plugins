// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  installTestPluginRuntime,
  renderSlot,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import { EditorView } from "@codemirror/view";
import { $getNearestNodeFromDOMNode, $isTextNode, getNearestEditorFromDOMNode } from "lexical";
installTestPluginRuntime();
// jsdom has no layout API; CodeMirror measures text ranges when source opens.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const { MarkdownEditor, previewUrl } = await import("./markdown-editor");

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function replaceText(element: HTMLElement, text: string) {
  const editor = getNearestEditorFromDOMNode(element);
  if (!editor) throw new Error("Editor is not mounted");
  await act(async () =>
    editor.update(
      () => {
        const node = $getNearestNodeFromDOMNode(element.firstChild ?? element);
        if (!$isTextNode(node)) throw new Error("Expected text");
        node.setTextContent(text);
      },
      { discrete: true },
    ),
  );
}

function open(
  content: string,
  path = "guide.mdx",
  canvas = false,
  handlers: NonNullable<RenderSlotOptions["rpc"]> = {},
) {
  const changed = vi.fn();
  const initialized = vi.fn();
  const applied = vi.fn();
  const slot = renderSlot(
    { component: MarkdownEditor },
    {
      initialValue: content,
      notePath: path,
      canvasSource: canvas ? { kind: "thread-storage", threadId: "thread-1", path } : undefined,
      previewBaseUrl: "/preview",
      onUpload: async () => ({ markdownPath: "./_attachments/image.png" }),
      onFirstRender: initialized,
      onMarkdownChange: changed,
      onProposalApplied: applied,
    },
    {
      rpc: {
        state: () => ({ values: {}, revision: 0 }),
        comments: () => ({
          status: "loaded",
          sha256: null,
          file: { version: 1, threads: [] },
          malformed: false,
        }),
        proposals: () => ({ file: { version: 1, proposals: [] } }),
        ...handlers,
      },
    },
  );
  return { slot, changed, initialized, applied };
}

it.each(["text", "paragraph", "blocks"])(
  "keeps Comment available for %s selection boundaries without editing the MDX",
  async (boundary) => {
    const comment = vi.fn((input) => ({
      sha256: "saved",
      file: { version: 1, threads: [input.op.thread] },
    }));
    const { slot, changed } = open("A **selected** passage.", "review.canvas.mdx", true, {
      comment,
    });
    const bold = await slot.findByText("selected");
    const paragraph = bold.closest("p")!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!.firstChild ?? paragraph.firstChild!, 0);
    const last = paragraph.lastChild!;
    range.setEnd(last.firstChild ?? last, (last.textContent ?? "").length);
    if (boundary === "paragraph") range.selectNodeContents(paragraph);
    if (boundary === "blocks") range.selectNode(paragraph);
    range.getBoundingClientRect = () => ({
      top: 0,
      bottom: 20,
      left: 0,
      right: 80,
      width: 80,
      height: 20,
      x: 0,
      y: 0,
      toJSON() {},
    });
    await act(async () => {
      const selected = window.getSelection()!;
      selected.removeAllRanges();
      selected.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    fireEvent.click(await slot.findByRole("button", { name: "Comment" }));
    fireEvent.change(await slot.findByPlaceholderText("Add a comment"), {
      target: { value: "Please verify this." },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Comment" }));
    await waitFor(() => expect(comment).toHaveBeenCalled());
    expect(comment.mock.calls[0]?.[0].op.thread.anchor.quote).toBe("A selected passage.");
    expect(changed).not.toHaveBeenCalled();
  },
);

it("preserves an unfinished comment across closing and keyboard tab navigation", async () => {
  const comment = vi.fn((input) => ({
    sha256: "saved",
    file: { version: 1, threads: [input.op.thread] },
  }));
  const { slot } = open("A selected passage.", "draft.canvas.mdx", true, { comment });
  const passage = await slot.findByText("A selected passage.");
  expect(slot.getByRole("button", { name: /Review ·/ }).getAttribute("aria-expanded")).toBe(
    "false",
  );
  const range = document.createRange();
  range.selectNodeContents(passage.closest("p")!);
  range.getBoundingClientRect = () => new DOMRect(100, 200, 180, 20);
  await act(async () => {
    const selected = window.getSelection()!;
    selected.removeAllRanges();
    selected.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  fireEvent.click(await slot.findByRole("button", { name: "Comment" }));
  const field = await slot.findByRole("textbox", { name: "Add a comment" });
  fireEvent.change(field, { target: { value: "Keep this draft." } });
  fireEvent.click(slot.getByRole("button", { name: "Close review" }));
  expect(slot.queryByRole("textbox", { name: "Add a comment" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /Review ·/ }));
  expect((slot.getByRole("textbox", { name: "Add a comment" }) as HTMLTextAreaElement).value).toBe(
    "Keep this draft.",
  );
  fireEvent.keyDown(slot.getByRole("tab", { name: "Comments (0)" }), { key: "ArrowRight" });
  expect(slot.getByRole("tab", { name: "Suggested edits (0)" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  fireEvent.keyDown(slot.getByRole("tab", { name: "Suggested edits (0)" }), { key: "ArrowLeft" });
  expect((slot.getByRole("textbox", { name: "Add a comment" }) as HTMLTextAreaElement).value).toBe(
    "Keep this draft.",
  );
  fireEvent.keyDown(field, { key: "Escape" });
  expect(slot.getByRole("button", { name: /Review ·/ }).getAttribute("aria-expanded")).toBe(
    "false",
  );
  fireEvent.click(slot.getByRole("button", { name: /Review ·/ }));
  fireEvent.keyDown(field, { key: "Enter", metaKey: true, isComposing: true });
  expect(comment).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  expect(comment).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(comment).toHaveBeenCalledTimes(1));
  expect(comment.mock.calls[0]?.[0].op.thread.messages[0].body).toBe("Keep this draft.");
  const card = slot.container.querySelector("[data-margin-id] .canvas-comment-card")!;
  expect(card.getAttribute("data-active")).toBe("true");
  expect(card.querySelector(".canvas-comment-quote")).toBeNull();
  expect(await slot.findByRole("textbox", { name: "Reply" })).toBeTruthy();
});

it("accepts one suggestion through Canvas and reports the saved source without autosaving it", async () => {
  const proposal = {
    id: "one",
    title: "Clarify",
    author: "agent",
    createdAtMs: 1,
    before: "Original.",
    after: "Verified.",
    status: "pending",
  };
  const decide = vi.fn(() => ({
    content: "Verified.",
    sha256: "written-sha",
    file: { version: 1, proposals: [{ ...proposal, status: "accepted" }] },
  }));
  const { slot, applied, changed } = open("Original.", "review.canvas.mdx", true, {
    proposals: () => ({ file: { version: 1, proposals: [proposal] } }),
    decide,
  });
  fireEvent.click(await slot.findByRole("tab", { name: "Suggested edits (1)" }));
  fireEvent.click(await slot.findByRole("button", { name: "Accept" }));
  await waitFor(() =>
    expect(applied).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Verified.", sha256: "written-sha" }),
    ),
  );
  expect(decide).toHaveBeenCalledWith(
    expect.objectContaining({ proposal, decision: "accept", expectedContent: "Original." }),
  );
  expect(changed).not.toHaveBeenCalled();
});

it("does not save normalization when opening Markdown or MDX", async () => {
  const content = "# Heading\r\n\r\n*  Unusual whitespace\r\n";
  const { slot, changed, initialized } = open(content);
  await slot.findByText("Heading");
  expect(initialized).toHaveBeenCalledWith(content);
  expect(changed).not.toHaveBeenCalled();
  slot.unmount();
  expect(changed).not.toHaveBeenCalled();
});

it("renders directives and GFM inside Canvas widgets without falling back to source", async () => {
  const content = `# Evidence

<Card title="Trace">

> /pstack:teach explain this

| Claim | Result |
| --- | --- |
| ~~fixed~~ | still drifting |

- [x] Checked

</Card>

Original paragraph.
`;
  const { slot, changed } = open(content, "evidence.canvas.mdx", true);
  await slot.findByText("Trace");
  expect(slot.container.querySelector(".canvas-document")?.textContent).toContain("still drifting");
  expect(slot.container.querySelector(".canvas-document")?.textContent).toContain(
    "/pstack:teach explain this",
  );
  expect(changed).not.toHaveBeenCalled();
  await replaceText(await slot.findByText("Original paragraph."), "Updated paragraph.");
  await waitFor(() => expect(changed).toHaveBeenCalled());
  const saved = changed.mock.calls.at(-1)?.[0] as string;
  expect(saved).toContain("pstack:teach");
  expect(saved).toContain("~~fixed~~");
  expect(saved).toContain("[x] Checked");
});

it("preserves MDX imports, exports, JSX attributes, expressions, and frontmatter through edits", async () => {
  const header = "---\r\ntitle: Guide\r\n---\r\n";
  const { slot, changed } = open(
    header +
      `
import { Custom } from './custom'

export const answer = 42

# Guide

Original paragraph.

<Custom value={{ nested: [1, true] }}>Keep this.</Custom>

Value: {answer}
`,
  );
  await replaceText(await slot.findByText("Original paragraph."), "Updated paragraph.");
  await waitFor(() => expect(changed).toHaveBeenCalled());
  const markdown = changed.mock.calls.at(-1)?.[0] as string;
  expect(markdown.startsWith(header)).toBe(true);
  expect(markdown.match(/import \{ Custom \} from '\.\/custom'/g)).toHaveLength(1);
  expect(markdown.match(/export const answer = 42/g)).toHaveLength(1);
  expect(markdown).toContain("<Custom value={{ nested: [1, true] }}>");
  expect(markdown).toContain("Keep this.");
  expect(markdown).toContain("{answer}");
  expect(markdown).toContain("Updated paragraph.");
});

it("preserves aliased, default, unused, and side-effect imports without generating new ones", async () => {
  const declarations = `import Default from './default'
import { Named as Alias, unused } from './named'
import './styles.css'`;
  const { slot, changed } = open(`${declarations}

<Default><Alias /></Default>

Original paragraph.
`);
  await replaceText(await slot.findByText("Original paragraph."), "Updated paragraph.");
  await waitFor(() => expect(changed).toHaveBeenCalled());
  const markdown = changed.mock.calls.at(-1)?.[0] as string;
  expect(markdown).toContain(declarations);
  expect(markdown.match(/\bimport\b/g)).toHaveLength(3);
});

it("leaves ordinary Markdown braces as text", async () => {
  const { slot, changed } = open("Literal {not JavaScript}.\n\nOriginal paragraph.", "guide.md");
  await slot.findByText("Literal {not JavaScript}.");
  await replaceText(await slot.findByText("Original paragraph."), "Updated paragraph.");
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(changed.mock.calls.at(-1)?.[0]).toContain("Literal {not JavaScript}.");
});

it("opens literal angle-bracket placeholders in Markdown and preserves them after editing", async () => {
  const content = "# Commands\n\nRun command <group> <name>.\n\nOriginal paragraph.";
  const { slot, changed } = open(content, "guide.md");
  await slot.findByText("Run command <group> <name>.");
  expect(changed).not.toHaveBeenCalled();
  await replaceText(await slot.findByText("Original paragraph."), "Updated paragraph.");
  await waitFor(() => expect(changed).toHaveBeenCalled());
  const saved = changed.mock.calls.at(-1)?.[0] as string;
  slot.unmount();
  const reopened = open(saved, "guide.md");
  await reopened.slot.findByText("Run command <group> <name>.");
  await reopened.slot.findByText("Updated paragraph.");
  expect(reopened.changed).not.toHaveBeenCalled();
});

it.each([
  ["inline placeholders", "Run <group> <name> and </orphan>.", "Run <group> <name> and </orphan>."],
  ["block placeholders", "<group>\n<name>", "<group> <name>"],
  ["HTML comments", "<!-- unfinished comment", "<!-- unfinished comment"],
  [
    "HTML attributes",
    '<input disabled> and <img src="photo.png">',
    '<input disabled> and <img src="photo.png">',
  ],
  [
    "JSX expressions",
    "Use {value}, {{template}}, and ${ENV}.",
    "Use {value}, {{template}}, and ${ENV}.",
  ],
  [
    "generic types",
    "Map<string, List<T>> and x < 3 && y > 2",
    "Map<string, List<T>> and x < 3 && y > 2",
  ],
  ["declarations", "import {not javascript}\n\nexport this prose", "import {not javascript}"],
  ["inline code", "Use `<group>` and `{value}`.", "<group>"],
  [
    "shell text",
    "Run /pstack:teach and C:\\Users\\name.",
    "Run /pstack:teach and C:\\Users\\name.",
  ],
])("round-trips Markdown %s", async (_name, input, visible) => {
  const { slot, changed } = open(input + "\n\nOriginal paragraph.", "guide.markdown");
  await slot.findByText(visible, { exact: false });
  expect(changed).not.toHaveBeenCalled();
  await replaceText(await slot.findByText("Original paragraph."), "Updated paragraph.");
  await waitFor(() => expect(changed).toHaveBeenCalled());
  const saved = changed.mock.calls.at(-1)?.[0] as string;
  slot.unmount();
  const reopened = open(saved, "GUIDE.MD");
  await reopened.slot.findByText(visible, { exact: false });
  await reopened.slot.findByText("Updated paragraph.");
  expect(reopened.changed).not.toHaveBeenCalled();
});

it("keeps Markdown autolinks, formatting, and code fences intact", async () => {
  const content =
    "<https://example.com> and <reader@example.com>\n\n**Bold** and *italic* and ~~deleted~~\n\n```unknown-language\n<group> {broken expression}\n```\n\nOriginal paragraph.";
  const { slot, changed } = open(content, "guide.md");
  expect(
    (await slot.findByRole("link", { name: "https://example.com" })).getAttribute("href"),
  ).toBe("https://example.com");
  expect(slot.getByRole("link", { name: "reader@example.com" }).getAttribute("href")).toBe(
    "mailto:reader@example.com",
  );
  await replaceText(await slot.findByText("Original paragraph."), "Updated paragraph.");
  await waitFor(() => expect(changed).toHaveBeenCalled());
  const saved = changed.mock.calls.at(-1)?.[0] as string;
  expect(saved).toContain("**Bold**");
  expect(saved).toContain("*italic*");
  expect(saved).toContain("~~deleted~~");
  expect(saved).toContain("```unknown-language\n<group> {broken expression}\n```");
});

it.each([
  ["unclosed tag", "<group>"],
  ["mismatched tags", "<One>text</Two>"],
  ["invalid expression", "Value: {not valid JavaScript}"],
  ["unfinished import", "import { Broken"],
])("automatically opens source for MDX %s and recovers after correction", async (_name, syntax) => {
  const content = "---\ntitle: Keep this\n---\n\n# Before\n\n" + syntax;
  const { slot, changed } = open(content);
  await waitFor(() =>
    expect(slot.container.querySelector(".cm-sourceView .cm-content")).not.toBeNull(),
  );
  const source = EditorView.findFromDOM(
    slot.container.querySelector(".cm-sourceView .cm-content")!,
  )!;
  expect(source.state.doc.toString()).toContain(syntax);
  expect(changed).not.toHaveBeenCalled();
  await act(async () =>
    source.dispatch({
      changes: {
        from: 0,
        to: source.state.doc.length,
        insert: "# Corrected\n\nRecovered paragraph.",
      },
    }),
  );
  await waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      "---\ntitle: Keep this\n---\n\n# Corrected\n\nRecovered paragraph.",
    ),
  );
  fireEvent.click(slot.getByRole("radio", { name: "Rich text" }));
  await slot.findByText("Recovered paragraph.");
  expect(
    slot.container.querySelector(".mdxeditor-rich-text-editor")?.getAttribute("style"),
  ).toContain("display: block");
});

it("does not save when switching modes or focusing unchanged source", async () => {
  const content = "# Heading\r\n\r\n*  Unusual whitespace\r\n";
  const { slot, changed } = open(content, "guide.md");
  await slot.findByText("Heading");
  fireEvent.click(slot.getByRole("radio", { name: "Source mode" }));
  const source = EditorView.findFromDOM(
    slot.container.querySelector(".cm-sourceView .cm-content")!,
  )!;
  await act(async () => source.dispatch({ selection: { anchor: 1 } }));
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("radio", { name: "Rich text" }));
  await slot.findByText("Heading");
  expect(changed).not.toHaveBeenCalled();
});

it.each(["# Before\n\n<Unclosed", "# Before\n\nValid paragraph."])(
  "keeps the latest source after an unsuccessful rich-text retry from %s",
  async (initial) => {
    const { slot, changed } = open(initial);
    if (initial.includes("Valid paragraph.")) {
      await slot.findByText("Valid paragraph.");
      fireEvent.click(slot.getByRole("radio", { name: "Source mode" }));
    }
    await waitFor(() =>
      expect(slot.container.querySelector(".cm-sourceView .cm-content")).not.toBeNull(),
    );
    const source = EditorView.findFromDOM(
      slot.container.querySelector(".cm-sourceView .cm-content")!,
    )!;
    const edited = "# Unsaved elsewhere\n\n<StillBroken";
    await act(async () =>
      source.dispatch({ changes: { from: 0, to: source.state.doc.length, insert: edited } }),
    );
    expect(changed).toHaveBeenLastCalledWith(edited);
    fireEvent.click(slot.getByRole("radio", { name: "Rich text" }));
    await waitFor(() =>
      expect(slot.container.querySelector(".cm-sourceView .cm-content")).not.toBeNull(),
    );
    const recovered = EditorView.findFromDOM(
      slot.container.querySelector(".cm-sourceView .cm-content")!,
    )!;
    expect(recovered.state.doc.toString()).toBe("# Unsaved elsewhere\n\n<StillBroken");
    expect(changed).toHaveBeenCalledTimes(1);
  },
);

it("resolves attachments from the document directory without changing stored paths", () => {
  expect(previewUrl("/preview", "notes/deep/file.mdx", "../image.png")).toBe(
    "/preview/notes/image.png",
  );
  expect(previewUrl("/preview", "notes/file.md", "/image.png")).toBe("/preview/image.png");
  expect(previewUrl("/preview", "notes/file.md", "https://example.com/image.png")).toBe(
    "https://example.com/image.png",
  );
});
