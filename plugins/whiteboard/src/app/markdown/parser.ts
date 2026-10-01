import { Editor, Extension, type AnyExtension } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

/**
 * The Docs plugin's TipTap extensions (its `app.tsx` `TiptapEditor`), minus its
 * editor-only ones (proposal diff, task input rule, HTML embed, placeholder). Four deltas, each
 * keeping upstream Whiteboard semantics where Docs would lose content:
 *
 * 1. `html: false`. Agent text never becomes markup; raw HTML shows as text, as upstream does.
 * 2. `linkify: false`. Upstream's mdast parser decides what is a link (`preprocess.ts` rewrites
 *    every mdast link, literal autolinks included). markdown-it's fuzzy linkify would turn
 *    `README.md` into `http://README.md`.
 * 3. Inline code coexists with other marks. TipTap's Code mark excludes every mark, so
 *    `` [`File.ts`](review-source:…) `` would lose its link. It is moved last so `<code>` nests
 *    innermost, as in upstream's rendering.
 * 4. A soft line break after inline markup stays whitespace (`SoftBreakAfterInline`).
 */
const DocsStarterKit = StarterKit.extend({
  // StarterKit reads `this.options.<name>`; an extension without `addOptions` has none.
  addOptions: () => ({}),
  addExtensions() {
    const kit = this.parent?.() ?? [];
    const code = kit.find((extension) => extension.name === "code");
    const rest = kit.filter((extension) => extension !== code);

    return code ? [...rest, code.extend({ excludes: "" })] : rest;
  },
});

/**
 * tiptap-markdown's `normalizeDOM` strips the newline that starts a text node after any element.
 * That is meant for the newline after a block, but it also eats a soft line break after inline
 * code, a link or emphasis: "`foo`\nand bar" renders "fooand bar" (in Docs too). Upstream renders
 * the break as whitespace. This `updateDOM` hook runs before `normalizeDOM` and turns such a
 * newline into a space. A newline alone (between blocks) is left for `normalizeDOM`.
 */
const SoftBreakAfterInline = Extension.create({
  name: "whiteboardSoftBreakAfterInline",
  addStorage: () => ({
    markdown: {
      parse: {
        updateDOM(element: HTMLElement) {
          for (const node of element.querySelectorAll("*")) {
            const next = node.nextSibling;
            if (next?.nodeType !== 3 || node.closest("pre")) continue;
            const text = next.textContent ?? "";
            if (/^\n[^\n]/.test(text)) next.textContent = ` ${text.slice(1)}`;
          }
        },
      },
    },
  }),
});

export const MARKDOWN_EXTENSIONS: AnyExtension[] = [
  DocsStarterKit,
  Link.configure({ openOnClick: false, autolink: true }),
  Image.configure({ allowBase64: false }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: true, lastColumnResizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  SoftBreakAfterInline,
  Markdown.configure({
    html: false,
    tightLists: true,
    bulletListMarker: "-",
    linkify: false,
  }),
];

const CACHE_LIMIT = 256;
const cache = new Map<string, ProseMirrorNode>();
let editor: Editor | undefined;

/** Markdown to a ProseMirror document through one shared read-only editor, memoized by source. */
export function parse(markdown: string): ProseMirrorNode {
  const cached = cache.get(markdown);
  if (cached) return cached;

  editor ??= new Editor({ extensions: MARKDOWN_EXTENSIONS, editable: false });
  editor.commands.setContent(markdown, false);
  const doc = editor.state.doc;

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(markdown, doc);
  return doc;
}
