// @vitest-environment jsdom
import { type AnyExtension, Editor } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProsePeekAnchor } from "../vendor/review/app/src/review-components.tsx";
import { documentHeadings } from "../../shared/vendor/review/src/review-api/document-headings.ts";
import type { Block } from "../../shared/vendor/review/src/review-api/document.ts";
import { AgentMarkdown, MarkdownContent } from "./agent-markdown.tsx";
import { MARKDOWN_EXTENSIONS } from "./parser.ts";
import { preprocess } from "./preprocess.ts";

afterEach(cleanup);

const SPECIMEN = `# Title with [**Save**][save]

Intro with \`inline code\`, a literal \`[x](review-source:head/a.ts#L1)\` span, and **bold \`code\`**.

## Overview

[old](review-source:base/src/old.ts#L1), [new *one*][new] and [\`App.tsx\`](review-source:head/app/App.tsx#L10-L24).

Encoded: [naïve](<review-source:head/src/naïve file.ts#L3>).

## Overview

### Details

See [the overview](#overview), [docs](https://example.com/docs "Docs"), [home](/Users/alice/repo/src/a.ts:12), [run](javascript:alert(1)), https://bare.example.com/x and README.md.

A claim[^b] and another[^a].

| File | Status |
| --- | --: |
| \`a.ts\` | ok |

\`\`\`ts
const answer: number = 42;
\`\`\`

![remote](https://img.example/a.png)

![insecure](http://img.example/b.png)

[save]: review-source:head/src/save.ts#L2
[new]: review-source:head/src/new.ts#L5

[^a]: Footnote A with [link](https://a.example).
[^b]: Footnote B.
`;

/** Upstream `blocks.tsx` `MarkdownBlock`: anchors keyed by block id and mdast href. */
function renderSpecimen(seen: string[] = []) {
  const headings = documentHeadings([
    { id: "block-1", type: "markdown", markdown: SPECIMEN } as Block,
  ]);
  const view = render(
    createElement(MarkdownContent, {
      source: SPECIMEN,
      allowRemoteImages: true,
      headingId: (index) => headings[index]?.id,
      h1: ({ children }: { children?: ReactNode }) =>
        createElement("h1", { "data-title": "" }, children),
      renderLink: (href, children) => {
        if (!href.startsWith("review-source:")) return undefined;
        seen.push(href);
        // Upstream `ProsePeekAnchor`'s markup.
        return createElement(
          "a",
          { href: `#review-anchor-block-1:${href}`, "data-review-anchor-id": `block-1:${href}` },
          children,
        );
      },
    }),
  );
  return { ...view, headings };
}

describe("markdown specimen", () => {
  it("passes every review-source href to renderLink as the mdast URL, in document order", () => {
    const seen: string[] = [];
    const { container } = renderSpecimen(seen);

    expect(seen).toEqual([
      "review-source:head/src/save.ts#L2",
      "review-source:base/src/old.ts#L1",
      "review-source:head/src/new.ts#L5",
      "review-source:head/app/App.tsx#L10-L24",
      "review-source:head/src/naïve file.ts#L3",
    ]);
    expect(
      [...container.querySelectorAll("[data-wb-href]")].map((span) => [
        span.tagName,
        span.getAttribute("data-wb-href"),
        span.innerHTML,
      ]),
    ).toEqual([
      [
        "SPAN",
        "review-source:head/src/save.ts#L2",
        '<a href="#review-anchor-block-1:review-source:head/src/save.ts#L2" data-review-anchor-id="block-1:review-source:head/src/save.ts#L2"><strong>Save</strong></a>',
      ],
      [
        "SPAN",
        "review-source:base/src/old.ts#L1",
        '<a href="#review-anchor-block-1:review-source:base/src/old.ts#L1" data-review-anchor-id="block-1:review-source:base/src/old.ts#L1">old</a>',
      ],
      [
        "SPAN",
        "review-source:head/src/new.ts#L5",
        '<a href="#review-anchor-block-1:review-source:head/src/new.ts#L5" data-review-anchor-id="block-1:review-source:head/src/new.ts#L5">new <em>one</em></a>',
      ],
      [
        "SPAN",
        "review-source:head/app/App.tsx#L10-L24",
        '<a href="#review-anchor-block-1:review-source:head/app/App.tsx#L10-L24" data-review-anchor-id="block-1:review-source:head/app/App.tsx#L10-L24"><code>App.tsx</code></a>',
      ],
      [
        "SPAN",
        "review-source:head/src/naïve file.ts#L3",
        '<a href="#review-anchor-block-1:review-source:head/src/naïve file.ts#L3" data-review-anchor-id="block-1:review-source:head/src/naïve file.ts#L3">naïve</a>',
      ],
    ]);
    expect(container.querySelectorAll("a a")).toHaveLength(0);
    expect(container.innerHTML).not.toContain("%20");
  });

  it("keeps a review-source link written inside a code span literal", () => {
    const { container } = renderSpecimen();

    expect(container.querySelector("p")?.innerHTML).toBe(
      "Intro with <code>inline code</code>, a literal <code>[x](review-source:head/a.ts#L1)</code> span, and <strong>bold <code>code</code></strong>.",
    );
  });

  it("assigns h2/h3 ids from document-headings slugs and renders h1 through the title component", () => {
    const { container, headings } = renderSpecimen();

    expect(headings.map((heading) => heading.id)).toEqual(["overview", "overview-2", "details"]);
    expect(
      [...container.querySelectorAll("h1, h2, h3")].map((heading) => [
        heading.tagName,
        heading.id,
        heading.textContent,
        heading.parentElement?.className ?? "",
      ]),
    ).toEqual([
      ["H1", "", "Title with Save", ""],
      ["H2", "overview", "Overview", "bb-markdown-prose"],
      ["H2", "overview-2", "Overview", "bb-markdown-prose"],
      ["H3", "details", "Details", "bb-markdown-prose"],
    ]);
    expect(container.querySelector("h1")?.hasAttribute("data-title")).toBe(true);
  });

  it("renders other links with upstream semantics", () => {
    const { container } = renderSpecimen();
    const paragraph = [...container.querySelectorAll("p")].find((p) =>
      p.textContent?.startsWith("See "),
    );

    expect(paragraph?.innerHTML).toBe(
      'See <a href="#overview">the overview</a>, ' +
        '<a href="https://example.com/docs" title="Docs" target="_blank" rel="noopener noreferrer">docs</a>, ' +
        '<code class="agent-markdown-code-reference">home</code>, ' +
        "<span>run</span>, " +
        '<a href="https://bare.example.com/x" target="_blank" rel="noopener noreferrer">https://bare.example.com/x</a> ' +
        "and README.md.",
    );
    expect(container.innerHTML).not.toContain("javascript:");
    expect(container.innerHTML).not.toContain("/Users/alice");
  });

  it("scrolls a #heading link to its heading in place", () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    const { container } = renderSpecimen();
    const link = container.querySelector<HTMLAnchorElement>('a[href="#overview"]')!;

    expect(fireEvent.click(link)).toBe(false); // default prevented
    expect(scrolled).toEqual([container.querySelector("h2#overview")]);
  });

  it("renders footnote references in place and definitions after the body in source order", () => {
    const { container } = renderSpecimen();

    expect(
      [...container.querySelectorAll("sup > a[data-footnote-ref]")].map((ref) => [
        ref.getAttribute("href"),
        ref.id,
        ref.textContent,
      ]),
    ).toEqual([
      ["#fn-b", "fnref-b", "b"],
      ["#fn-a", "fnref-a", "a"],
    ]);
    const section = container.querySelector("section[data-footnotes].footnotes");
    expect(section?.parentElement?.lastElementChild).toBe(section);
    expect(section?.innerHTML).toBe(
      '<ol><li id="fn-a"><p>Footnote A with <a href="https://a.example" target="_blank" rel="noopener noreferrer">link</a>.</p></li>' +
        '<li id="fn-b"><p>Footnote B.</p></li></ol>',
    );
  });

  it("renders the GFM table, the ts fence, and only https images", () => {
    const { container } = renderSpecimen();

    expect(container.querySelector("table")?.outerHTML).toBe(
      '<table style="min-width: 50px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup>' +
        '<tbody><tr><th colspan="1" rowspan="1"><p>File</p></th><th colspan="1" rowspan="1"><p>Status</p></th></tr>' +
        '<tr><td colspan="1" rowspan="1"><p><code>a.ts</code></p></td><td colspan="1" rowspan="1"><p>ok</p></td></tr></tbody></table>',
    );
    expect(container.querySelector("pre")?.outerHTML).toBe(
      '<pre><code class="language-ts">const answer: number = 42;</code></pre>',
    );
    expect(
      [...container.querySelectorAll("img")].map((img) => [img.getAttribute("src"), img.alt]),
    ).toEqual([["https://img.example/a.png", "remote"]]);
    expect([...container.querySelectorAll("p > em")].map((em) => em.textContent)).toContain(
      "insecure",
    );
  });

  it("highlights a quote in prose and inline code, not in tables or fences", () => {
    const { container } = render(
      createElement(AgentMarkdown, {
        source:
          "We should optimize database queries.\n\n- `optimize database queries`\n\n| optimize database queries |\n| --- |\n| x |\n\n```\noptimize database queries\n```",
        highlightQuote: "optimize database queries",
      }),
    );

    expect(
      [...container.querySelectorAll("mark.review-trace-quote-mark")].map(
        (mark) => mark.parentElement?.tagName,
      ),
    ).toEqual(["P", "CODE"]);
    expect(container.firstElementChild?.className).toBe("agent-markdown bb-markdown-prose");
  });
});

describe("parser divergence guards (audit)", () => {
  it("never renders an image the policy rejects, even where only markdown-it sees one", () => {
    // mdast reads `<div>…</div>` as raw HTML; markdown-it with `html: false` reads a paragraph.
    const images = (element: ReturnType<typeof createElement>) =>
      [...render(element).container.querySelectorAll("img")].map((img) => img.getAttribute("src"));

    expect(
      images(createElement(AgentMarkdown, { source: "<div>![x](https://a.example/a.png)</div>" })),
    ).toEqual([]);
    expect(
      images(
        createElement(MarkdownContent, {
          source: "<div>![x](http://a.example/b.png)</div>",
          allowRemoteImages: true,
        }),
      ),
    ).toEqual([]);
    expect(
      images(
        createElement(MarkdownContent, {
          source: "<div>![x](https://a.example/c.png)</div>",
          allowRemoteImages: true,
        }),
      ),
    ).toEqual(["https://a.example/c.png"]);
  });

  it("keeps a footnote reference inside a link label literal instead of leaking a placeholder", () => {
    const { container } = render(
      createElement(MarkdownContent, { source: "[see[^1]](https://x.example)\n\n[^1]: n" }),
    );

    expect(container.querySelector("p")?.innerHTML).toBe(
      '<a href="https://x.example" target="_blank" rel="noopener noreferrer">see[^1]</a>',
    );
  });

  it("renders every definition of a repeated footnote label without a React key clash", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      createElement(MarkdownContent, { source: "A[^1]\n\n[^1]: one\n[^1]: two" }),
    );

    expect(
      [...container.querySelectorAll("section[data-footnotes] li")].map((li) => [
        li.id,
        li.textContent,
      ]),
    ).toEqual([
      ["fn-1", "one"],
      ["fn-1", "two"],
    ]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("keeps a soft line break after inline markup as whitespace", () => {
    const { container } = render(
      createElement(AgentMarkdown, {
        source: "See `foo`\nand [docs](https://d.example)\nthen **bold**\nend.",
      }),
    );

    expect(container.querySelector("p")?.textContent).toBe("See foo and docs then bold end.");
  });
});

describe("vendored peek anchor", () => {
  it("opens the peek from a code-labelled review-source link without nesting anchors", () => {
    const opened: string[] = [];
    const { container } = render(
      createElement(MarkdownContent, {
        source: "See [`File.ts`](review-source:head/src/File.ts#L1).",
        renderLink: (_href, children) => (
          <ProsePeekAnchor
            href="#review-anchor-block-1"
            anchorId="block-1"
            isOpen={false}
            onOpen={(text) => {
              opened.push(text);
            }}
          >
            {children}
          </ProsePeekAnchor>
        ),
      }),
    );

    expect(container.innerHTML).toBe(
      '<div class="bb-markdown-prose"><p>See <span data-wb-href="review-source:head/src/File.ts#L1">' +
        '<a href="#review-anchor-block-1" data-review-anchor-id="block-1"><code>File.ts</code></a></span>.</p></div>',
    );
    expect(fireEvent.click(container.querySelector("a")!)).toBe(false);
    expect(opened).toEqual(["File.ts"]);
  });
});

describe("Docs parity", () => {
  /** A read-only Docs editor over the same extension list. */
  function docsEditorHtml(markdown: string, extensions = MARKDOWN_EXTENSIONS): string {
    const element = document.createElement("div");
    const editor = new Editor({
      element,
      editable: false,
      extensions,
      content: markdown,
    });
    const root = editor.view.dom.cloneNode(true) as HTMLElement;
    editor.destroy();
    return normalized(root, "a");
  }

  /** Our blocks with prose wrappers unwrapped, minus the footnote section and heading ids. */
  function oursHtml(container: HTMLElement): string {
    const root = document.createElement("div");
    const clone = container.cloneNode(true);
    for (let child = clone.firstChild; child; child = clone.firstChild)
      if (child instanceof Element && child.classList.contains("bb-markdown-prose")) {
        root.append(...child.childNodes);
        child.remove();
      } else root.append(child);
    root.querySelector("section[data-footnotes]")?.remove();
    for (const heading of root.querySelectorAll(":is(h1, h2, h3)")) {
      heading.removeAttribute("id");
      heading.removeAttribute("data-title");
    }
    return normalized(
      root,
      "a, [data-wb-href], code.agent-markdown-code-reference, sup, span:not([data-wb-href], label > span)",
    );
  }

  /**
   * Link elements are where upstream's link semantics replace the link mark's `<a>`: both sides
   * unwrap them to their text. Editor-only artifacts (contenteditable, draggable, trailing breaks)
   * go, and attributes are compared as a sorted set.
   */
  function normalized(root: HTMLElement, links: string): string {
    for (let link = root.querySelector(links); link; link = root.querySelector(links)) {
      if (link.matches("code.agent-markdown-code-reference"))
        link.replaceWith(link.textContent ?? "");
      else link.replaceWith(...link.childNodes);
    }
    root
      .querySelectorAll(".ProseMirror-trailingBreak, .ProseMirror-separator")
      .forEach((node) => node.remove());
    for (const element of root.querySelectorAll("*")) {
      element.removeAttribute("contenteditable");
      element.removeAttribute("draggable");
      if (element instanceof HTMLInputElement) element.toggleAttribute("checked", element.checked);
      if (element instanceof HTMLElement && element.hasAttribute("style"))
        element.setAttribute("style", element.style.cssText);
      const attributes = [...element.attributes].sort((a, b) => a.name.localeCompare(b.name));
      for (const attribute of attributes) element.removeAttribute(attribute.name);
      for (const attribute of attributes) element.setAttribute(attribute.name, attribute.value);
    }
    root.normalize();
    return root.innerHTML;
  }

  const PLAIN = [
    "# One",
    "## Two",
    "Text with **bold**, *em*, ~~struck~~, `code`, a &amp; b, <b>raw</b> and a  ",
    "hard break.",
    "",
    "> Quoted *text*",
    "",
    "1. first",
    "2. second",
    "",
    "- [ ] open task",
    "- [x] done task",
    "",
    "- tight",
    "- list",
    "  - nested",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | `2` |",
    "",
    "```ts",
    "const a = 1;",
    "```",
    "",
    "---",
    "",
    "###### Six",
  ].join("\n");

  it("leaves Markdown without links, images or footnotes untouched before parsing", () => {
    expect(preprocess(PLAIN, { allowRemoteImages: true }).markdown).toBe(PLAIN);
  });

  it("renders the editor's DOM for plain Markdown", () => {
    const { container } = render(createElement(MarkdownContent, { source: PLAIN }));

    expect(oursHtml(container)).toBe(docsEditorHtml(PLAIN));
    expect(oursHtml(container)).toContain('<ul data-type="taskList"><li data-checked="false">');
  });

  /** Docs' own extension list (`plugins/scott-docs/app.tsx` `TiptapEditor`), with only Q1's `html: false`. */
  const DOCS_LITERAL: AnyExtension[] = [
    StarterKit,
    Link.configure({ openOnClick: false, autolink: true }),
    Image.configure({ allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true, lastColumnResizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Markdown.configure({ html: false, tightLists: true, bulletListMarker: "-", linkify: true }),
  ];

  it("renders the literal Docs editor's DOM for plain Markdown", () => {
    const { container } = render(createElement(MarkdownContent, { source: PLAIN }));

    expect(oursHtml(container)).toBe(docsEditorHtml(PLAIN, DOCS_LITERAL));
  });

  it("renders the editor's DOM for the specimen, apart from link elements, ids and footnotes", () => {
    const { container } = renderSpecimen();
    const prepared = preprocess(SPECIMEN, { allowRemoteImages: true }).markdown;

    expect(oursHtml(container)).toBe(docsEditorHtml(prepared));
  });

  it("uses the Docs extension list with the four documented deltas", () => {
    const options = Object.fromEntries(
      MARKDOWN_EXTENSIONS.map((extension) => [extension.name, extension.options]),
    );

    expect(Object.keys(options)).toEqual([
      "starterKit",
      "link",
      "image",
      "taskList",
      "taskItem",
      "table",
      "tableRow",
      "tableHeader",
      "tableCell",
      "whiteboardSoftBreakAfterInline", // not in Docs
      "markdown",
    ]);
    expect(options.link).toMatchObject({ openOnClick: false, autolink: true });
    expect(options.image).toMatchObject({ allowBase64: false });
    expect(options.taskItem).toMatchObject({ nested: true });
    expect(options.table).toMatchObject({ resizable: true, lastColumnResizable: false });
    expect(options.markdown).toMatchObject({
      html: false, // Docs: true
      tightLists: true,
      bulletListMarker: "-",
      linkify: false, // Docs: true
    });

    const editor = new Editor({ extensions: MARKDOWN_EXTENSIONS });
    const marks = Object.values(editor.schema.marks);
    editor.destroy();
    expect(marks.map((mark) => [mark.name, mark.spec.excludes])).toEqual([
      ["link", undefined],
      ["bold", undefined],
      ["italic", undefined],
      ["strike", undefined],
      ["code", ""], // Docs: "_", listed after bold
    ]);
  });
});
