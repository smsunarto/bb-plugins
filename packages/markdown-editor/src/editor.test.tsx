import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { Editor } from "@tiptap/core";
import { MarkdownEditor, type MarkdownEditorProps } from "./editor";
import { createMarkdownEditor, sourceModeReason } from "./engine";

afterEach(cleanup);
function Controlled(
  props: Omit<MarkdownEditorProps, "onChange"> & { onChange?(text: string): void },
) {
  const [value, setValue] = useState(props.value);
  return (
    <MarkdownEditor
      {...props}
      value={value}
      onChange={(text) => {
        setValue(text);
        props.onChange?.(text);
      }}
    />
  );
}

it("restores original noncanonical Markdown after rich edit and undo", () => {
  const original = "---\ntitle: Test\n---\n\n__Keep me__\n\n* untouched\n";
  const { editor, session } = createMarkdownEditor({ value: original });
  editor.commands.insertContentAt(3, "x");
  expect(session.getMarkdown()).not.toBe(original);
  expect(session.getMarkdown()).toContain("* untouched\n");
  editor.commands.undo();
  expect(session.getMarkdown()).toBe(original);
  editor.destroy();
});

it("mode switches emit no change or save; external blur saves latest draft once", async () => {
  const changes: string[] = [];
  const blurs: string[] = [];
  render(
    <>
      <Controlled
        aria-label="Instructions"
        value="Original\n"
        onChange={(text) => changes.push(text)}
        onBlur={(text) => blurs.push(text)}
      />
      <button>Outside</button>
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Markdown source" }));
  const source = screen.getByRole("textbox");
  source.focus();
  fireEvent.change(source, { target: { value: "Latest\n" } });
  const rich = screen.getByRole("button", { name: "Rich text" });
  rich.focus();
  fireEvent.click(rich);
  await act(async () => {});
  expect(changes).toEqual(["Latest\n"]);
  expect(blurs).toEqual([]);
  const toggle = screen.getByRole("button", { name: "Markdown source" });
  toggle.focus();
  fireEvent.click(toggle);
  await act(async () => {});
  expect(changes).toEqual(["Latest\n"]);
  screen.getByRole("textbox").focus();
  screen.getByRole("button", { name: "Outside" }).focus();
  await act(async () => {});
  expect(blurs).toEqual(["Latest\n"]);
});

it("preserves CRLF and suggestion fences in source mode without an initial change", () => {
  const original = "```suggestion\r\nreplacement\r\n```\r\n";
  const changes: string[] = [];
  render(
    <Controlled aria-label="Summary" value={original} onChange={(text) => changes.push(text)} />,
  );
  expect(screen.getByRole("button", { name: "Rich text" })).toHaveProperty("disabled", true);
  expect(changes).toEqual([]);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "```suggestion\nnew\n```\n" } });
  expect(changes).toEqual(["```suggestion\r\nnew\r\n```\r\n"]);
});

it("rejects rich transactions exceeding the serialized Markdown limit", () => {
  let editor: Editor | null = null;
  const changes: string[] = [];
  render(
    <Controlled
      aria-label="Rule"
      value="ok"
      maxLength={4}
      onChange={(text) => changes.push(text)}
      onEditor={(value) => {
        editor = value;
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Rich text" }));
  if (!editor) throw new Error("Rich editor did not mount");
  const active: Editor = editor;
  act(() => {
    active.commands.selectAll();
    active.commands.setBold();
  });
  expect(screen.getByRole("alert").textContent).toContain("4 character");
  expect(changes).toEqual([]);
  expect(active.getText()).toBe("ok");
});

it("keeps read-only source content and forwards submission shortcuts", () => {
  let submitted = 0;
  render(
    <MarkdownEditor
      aria-label="Review"
      id="review"
      aria-describedby="hint"
      value="saved"
      readOnly
      onChange={() => {
        throw new Error("read-only edit");
      }}
      onKeyDown={(event) => {
        if (event.ctrlKey && event.key === "Enter") submitted++;
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Markdown source" }));
  expect(screen.getByRole("textbox")).toHaveProperty("readOnly", true);
  fireEvent.keyDown(screen.getByRole("textbox"), { ctrlKey: true, key: "Enter" });
  expect(submitted).toBe(1);
});

describe("source fidelity gate", () => {
  for (const source of [
    "[ref]: https://example.com\n",
    "before\n\n<!-- hidden -->",
    "$$\nx\n$$",
    '::html{src="x"}',
  ]) {
    it(`keeps syntax visible: ${source.slice(0, 15)}`, () =>
      expect(sourceModeReason(source)).not.toBeNull());
  }
});

it("keeps an untouched equal paragraph's source when another paragraph becomes equal", () => {
  const { editor, session } = createMarkdownEditor({ value: "first\n\n__same__\n" });
  editor.commands.insertContentAt({ from: 1, to: 6 }, "same");
  expect(session.getMarkdown()).toBe("same\n\n__same__\n");
  editor.destroy();
});

it("offers rich editing after hidden source is replaced without remounting", () => {
  const changes: string[] = [];
  render(
    <Controlled
      aria-label="Instructions"
      value="![image](data:image/png;base64,aGVsbG8=)"
      onChange={(text) => changes.push(text)}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Rich text" }));
  expect(
    screen.getByText("Source mode preserves content the rich editor cannot display."),
  ).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), {
    target: { value: "Ordinary Markdown" },
  });
  const rich = screen.getByRole("button", { name: "Rich text" });
  expect(rich).toHaveProperty("disabled", false);
  expect(screen.getByRole("textbox", { name: "Instructions" }).tagName).toBe("TEXTAREA");
  fireEvent.click(rich);
  expect(screen.getByRole("textbox", { name: "Instructions" }).textContent).toBe(
    "Ordinary Markdown",
  );
  expect(changes).toEqual(["Ordinary Markdown"]);
});

it("renders rich immediately and keeps code containing angle brackets editable", () => {
  let editor: Editor | null = null;
  render(
    <Controlled
      aria-label="Instructions"
      value={"`<id>`\n\n```ts\nArray<T>\n```"}
      onEditor={(value) => {
        editor = value;
      }}
    />,
  );
  const rich = screen.getByRole("textbox", { name: "Instructions" });
  expect(rich.tagName).toBe("DIV");
  expect(screen.getByRole("button", { name: "Rich text" })).toHaveProperty("disabled", false);
  act(() => {
    editor!.commands.insertContentAt(editor!.state.doc.content.size - 1, " Array<U>");
  });
  expect(screen.getByRole("textbox", { name: "Instructions" })).toBe(rich);
  expect(editor!.getText()).toContain("Array<U>");
});

it("keeps a typed HTML-like value in its active rich session", () => {
  let editor: Editor | null = null;
  render(
    <Controlled
      aria-label="Instructions"
      value="Text"
      onEditor={(value) => {
        editor = value;
      }}
    />,
  );
  const rich = screen.getByRole("textbox", { name: "Instructions" });
  act(() => {
    editor!.commands.insertContentAt(editor!.state.doc.content.size - 1, " <kbd>key</kbd>");
  });
  expect(screen.getByRole("textbox", { name: "Instructions" })).toBe(rich);
});

it("emits hidden reference definitions only once after a cut and reinsertion", () => {
  const { editor, session } = createMarkdownEditor({ value: "x\n\n[ref]: http://e\n\ny" });
  editor.commands.deleteRange({ from: 0, to: 3 });
  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: "paragraph",
    content: [{ type: "text", text: "x" }],
  });
  const result = session.getMarkdown();
  expect(result.match(/\[ref\]: http:\/\/e/g)).toHaveLength(1);
  expect(result.indexOf("y")).toBeLessThan(result.lastIndexOf("x"));
  editor.destroy();
});

it("shows and edits bounded skill YAML separately without rewriting the body", () => {
  const changes: string[] = [];
  render(
    <Controlled
      aria-label="SKILL.md"
      value={"---\nname: test\n---\n\n__Body__\n"}
      onChange={(value) => changes.push(value)}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Frontmatter" })).toHaveProperty(
    "value",
    "name: test\n",
  );
  expect(screen.getByRole("textbox", { name: "SKILL.md" }).textContent).toBe("Body");
  expect(changes).toEqual([]);
  fireEvent.change(screen.getByRole("textbox", { name: "Frontmatter" }), {
    target: { value: "name: other\n" },
  });
  expect(changes).toEqual(["---\nname: other\n---\n\n__Body__\n"]);
  fireEvent.click(screen.getByRole("button", { name: "Markdown source" }));
  expect(screen.getByRole("textbox", { name: "SKILL.md" })).toHaveProperty("value", "\n__Body__\n");
  fireEvent.click(screen.getByRole("button", { name: "Rich text" }));
  expect(changes).toHaveLength(1);
});

it("keeps body identity and YAML bytes through body edits and invalid intermediate YAML", () => {
  const changes: string[] = [];
  let editor: Editor | null = null;
  render(
    <Controlled
      aria-label="SKILL.md"
      value={"---\nname: test\n---\n\nBody\n"}
      onChange={(value) => changes.push(value)}
      onEditor={(value) => {
        editor = value;
      }}
    />,
  );
  const body = screen.getByRole("textbox", { name: "SKILL.md" });
  fireEvent.change(screen.getByRole("textbox", { name: "Frontmatter" }), {
    target: { value: "name: [\n" },
  });
  expect(screen.getByRole("textbox", { name: "Frontmatter" })).toHaveProperty("value", "name: [\n");
  expect(screen.getByRole("textbox", { name: "SKILL.md" })).toBe(body);
  expect(changes.at(-1)).toBe("---\nname: [\n---\n\nBody\n");
  act(() => {
    editor!.commands.insertContentAt(editor!.state.doc.content.size - 1, " edited");
  });
  expect(changes.at(-1)).toBe("---\nname: [\n---\n\nBody edited\n");
  expect(screen.getByRole("textbox", { name: "SKILL.md" })).toBe(body);
});

for (const blocked of [true, false]) {
  it(`handles rich submit before HardBreak when blocked=${blocked}`, () => {
    const changes: string[] = [];
    let submitted = 0;
    render(
      <Controlled
        aria-label="Review"
        aria-keyshortcuts="Control+Enter Meta+Enter"
        value="Draft"
        onChange={(value) => changes.push(value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            if (!blocked) submitted++;
          }
        }}
      />,
    );
    const rich = screen.getByRole("textbox", { name: "Review" });
    expect(rich.getAttribute("aria-keyshortcuts")).toBe("Control+Enter Meta+Enter");
    fireEvent.keyDown(rich, { ctrlKey: true, key: "Enter" });
    expect(submitted).toBe(blocked ? 0 : 1);
    expect(changes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Markdown source" }));
    const source = screen.getByRole("textbox", { name: "Review" });
    expect(source).toHaveProperty("value", "Draft");
    expect(source.getAttribute("aria-keyshortcuts")).toBe("Control+Enter Meta+Enter");
  });
}

it("keeps frontmatter delimiters, BOM, CRLF and body bytes when editing YAML", () => {
  const changes: string[] = [];
  render(
    <Controlled
      aria-label="SKILL.md"
      value={"\uFEFF---\r\nname: demo\r\n...\r\n__Body__\n"}
      onChange={(value) => changes.push(value)}
    />,
  );
  expect(screen.getByRole("textbox", { name: "SKILL.md" }).tagName).toBe("DIV");
  expect(changes).toEqual([]);
  fireEvent.change(screen.getByRole("textbox", { name: "Frontmatter" }), {
    target: { value: "name: changed\n" },
  });
  expect(changes).toEqual(["\uFEFF---\r\nname: changed\r\n...\r\n__Body__\n"]);
});
