// @vitest-environment jsdom
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { $getNearestNodeFromDOMNode, $isTextNode, getNearestEditorFromDOMNode } from "lexical";
installTestPluginRuntime();
const { MarkdownEditor, previewUrl } = await import("./markdown-editor");

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(cleanup);

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

function open(content: string, path = "guide.mdx", canvas = false) {
  const changed = vi.fn();
  const initialized = vi.fn();
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
    },
    { rpc: { state: () => ({ values: {}, revision: 0 }), comments: () => ({ threads: [] }) } },
  );
  return { slot, changed, initialized };
}

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

it("keeps malformed MDX available for source editing without saving a partial parse", async () => {
  const { slot, changed } = open("# Before\n\n<Unclosed\n");
  await slot.findByText(/You can fix the errors in source mode/);
  expect(changed).not.toHaveBeenCalled();
});

it("resolves attachments from the document directory without changing stored paths", () => {
  expect(previewUrl("/preview", "notes/deep/file.mdx", "../image.png")).toBe(
    "/preview/notes/image.png",
  );
  expect(previewUrl("/preview", "notes/file.md", "/image.png")).toBe("/preview/image.png");
  expect(previewUrl("/preview", "notes/file.md", "https://example.com/image.png")).toBe(
    "https://example.com/image.png",
  );
});
