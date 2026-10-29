import MarkdownIt from "markdown-it";
import { Editor, Extension, InputRule, type EditorOptions, type Extensions } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { loadMarkdownBlocks, saveMarkdownBlocks, type MarkdownBlocks } from "./markdown-blocks";
import { parseMarkdownDocument } from "./markdown-document";
import { HtmlBlock, HtmlSource } from "./raw-html";

const MarkdownTaskInput = Extension.create({
  name: "markdownTaskInput",
  priority: 200,
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*\[([ xX]?)\]\s$/,
        handler: ({ range, match, chain }) => {
          const commands = chain().deleteRange(range).toggleTaskList();
          if (/[xX]/.test(match[1] ?? "")) commands.updateAttributes("taskItem", { checked: true });
          commands.run();
        },
      }),
    ];
  },
});

export function markdownExtensions(placeholder = "Start writing…"): Extensions {
  return [
    StarterKit,
    Link.configure({ openOnClick: false, autolink: true }),
    Image.configure({ allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true, lastColumnResizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    MarkdownTaskInput,
    HtmlBlock,
    HtmlSource,
    Placeholder.configure({ placeholder }),
    Markdown.configure({ html: true, tightLists: true, bulletListMarker: "-", linkify: true }),
  ];
}

export interface MarkdownSession {
  getMarkdown(doc?: Node): string;
  load(value: string, refreshMedia?: boolean): void;
  hasHiddenContent(): boolean;
}

// The Docs block-preserving model is shared by every rich editing surface.
export function bindMarkdown(
  editor: Editor,
  value: string,
  transforms: {
    transformIn?(source: string): string;
    transformOut?(source: string): string;
  } = {},
): MarkdownSession {
  let source = value;
  let loaded: MarkdownBlocks;
  const display = (text: string) => transforms.transformIn?.(text) ?? text;
  const serialize = (nodes: Node[]): string => {
    const text: string = editor.storage.markdown.serializer.serialize(
      editor.schema.topNodeType.create(null, nodes),
    );
    return transforms.transformOut?.(text) ?? text;
  };
  const session: MarkdownSession = {
    getMarkdown: (doc = editor.state.doc) =>
      parseMarkdownDocument(source).frontmatter +
      saveMarkdownBlocks({ state: { doc } }, loaded, serialize),
    load(next, refreshMedia = false) {
      if (loaded && next === session.getMarkdown() && !refreshMedia) {
        source = next;
        return;
      }
      loaded = loadMarkdownBlocks(
        editor,
        parseMarkdownDocument(next).body,
        display,
        false,
        loaded && { loaded, serialize, refreshMedia },
      );
      source = next;
    },
    hasHiddenContent: () =>
      loaded.blocks.some((block) => block.source.trim() !== "" && block.nodes.length === 0),
  };
  session.load(value);
  return session;
}

export function createMarkdownEditor(
  options: Partial<EditorOptions> & {
    value: string;
    transformIn?(source: string): string;
    transformOut?(source: string): string;
  },
) {
  const { value, transformIn, transformOut, ...editorOptions } = options;
  const editor = new Editor({ extensions: markdownExtensions(), ...editorOptions, content: "" });
  const session = bindMarkdown(editor, value, { transformIn, transformOut });
  return { editor, session };
}

const fidelityParser = new MarkdownIt({ html: true });

export function sourceModeReason(value: string): string | null {
  const { body } = parseMarkdownDocument(value);
  if (/\r/.test(value)) return "Source mode preserves this document’s line endings.";
  const environment: { references?: Record<string, unknown> } = {};
  const tokens = fidelityParser.parse(body, environment);
  if (environment.references && Object.keys(environment.references).length)
    return "Source mode preserves link reference definitions.";
  if (
    tokens.some(
      (token) =>
        token.type === "html_block" ||
        (token.type === "fence" && token.info.trim().startsWith("suggestion")) ||
        token.children?.some(
          (child) =>
            child.type === "html_inline" ||
            (child.type === "text" && /^(?:::|\$\$)/m.test(child.content)),
        ),
    )
  )
    return "Source mode preserves embedded syntax in this document.";
  return null;
}

export function splitEditableDocument(value: string) {
  const match = /^((?:\uFEFF)?---\r?\n)([\s\S]*?)(^(?:---|\.\.\.)(?:\r?\n|$))/m.exec(value);
  if (!match || match.index !== 0) return { prefix: "", yaml: "", suffix: "", body: value };
  return {
    prefix: match[1]!,
    yaml: match[2]!,
    suffix: match[3]!,
    body: value.slice(match[0].length),
  };
}
