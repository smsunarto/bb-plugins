// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditableMarkdown, type OpenLink, type SaveMarkdown } from "./editable-markdown.tsx";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: {
  source: string;
  save: SaveMarkdown | null;
  headingId?: (index: number) => string | undefined;
  openLink?: OpenLink;
}) {
  act(() => root.render(createElement(EditableMarkdown, props)));
}

const editorDom = () => container.querySelector<HTMLElement>(".ProseMirror")!;
// TipTap exposes its editor on the view's DOM node.
const editor = () => (editorDom() as HTMLElement & { editor: Editor }).editor;

function typeAtEnd(text: string) {
  act(() => {
    editor().chain().focus("end").insertContent(text).run();
  });
}

async function blur() {
  await act(async () => {
    editorDom().dispatchEvent(new FocusEvent("blur"));
  });
}

describe("editable markdown", () => {
  it("saves an edit with the block's title, exact link URLs, local images and footnotes", async () => {
    const save = vi.fn<SaveMarkdown>().mockResolvedValue();
    render({
      source: [
        "# Title",
        "",
        'See [the save](<review-source:head/src/a b.ts#L2> "Save") and ![diagram](./local.png) here.[^note_1]',
        "",
        "[^note_1]: A note.",
      ].join("\n"),
      save,
    });

    // The local image is kept but never fetched.
    expect(editorDom().querySelector("img")?.hasAttribute("src")).toBe(false);

    typeAtEnd(" Added.");
    await blur();

    expect(save).toHaveBeenCalledExactlyOnceWith(
      [
        "# Title",
        "",
        'See [the save](<review-source:head/src/a b.ts#L2> "Save") and ![diagram](./local.png) here.[^note_1] Added.',
        "",
        "[^note_1]: A note.",
      ].join("\n"),
    );
  });

  it("does not save a blur without an edit", async () => {
    const save = vi.fn<SaveMarkdown>().mockResolvedValue();
    render({ source: "Plain text.", save });

    await blur();

    expect(save).not.toHaveBeenCalled();
  });

  it("follows newer versions until the user edits, then keeps the user's text", async () => {
    const save = vi.fn<SaveMarkdown>().mockResolvedValue();
    render({ source: "First.", save });
    render({ source: "Second.", save });
    expect(editorDom().textContent).toBe("Second.");

    typeAtEnd(" Mine.");
    render({ source: "Third from the agent.", save });
    expect(editorDom().textContent).toBe("Second. Mine.");

    await blur();
    expect(save).toHaveBeenCalledExactlyOnceWith("Second. Mine.");
  });

  it("is read-only without a save function", () => {
    render({ source: "Past version.", save: null });

    expect(editorDom().getAttribute("contenteditable")).toBe("false");
  });

  it("shows a failed save and writes it again on retry", async () => {
    const save = vi
      .fn<SaveMarkdown>()
      .mockRejectedValueOnce(new Error("session is locked"))
      .mockResolvedValue();
    render({ source: "Text.", save });

    typeAtEnd(" More.");
    await blur();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("session is locked");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    });

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("Text. More.");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("gives root h2 and h3 the document's heading ids", () => {
    render({
      source: "## One\n\ntext\n\n### Two",
      save: null,
      headingId: (index) => `heading-${index}`,
    });

    expect([...editorDom().querySelectorAll("h2, h3")].map((heading) => heading.id)).toEqual([
      "heading-0",
      "heading-1",
    ]);
  });

  it("opens a link's real URL on a modifier click, and only then while editable", () => {
    const openLink = vi.fn<OpenLink>().mockReturnValue(true);
    render({
      source: "[the save](review-source:head/a.ts#L2)",
      save: vi.fn<SaveMarkdown>().mockResolvedValue(),
      openLink,
    });
    const anchor = editorDom().querySelector("a")!;

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(openLink).not.toHaveBeenCalled();

    const click = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    anchor.dispatchEvent(click);
    expect(openLink).toHaveBeenCalledExactlyOnceWith("review-source:head/a.ts#L2", "the save");
    expect(click.defaultPrevented).toBe(true);
  });
});
