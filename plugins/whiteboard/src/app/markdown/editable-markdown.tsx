import { type AnyExtension, Editor, Extension, mergeAttributes } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { Link } from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  type ComponentType,
  type ReactElement,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Footnotes, MarkdownContent, PROSE } from "./agent-markdown.tsx";
import { type EditableSource, prepareEditable, restoreEditable } from "./editable.ts";
import { type LinkRenderer, urlProtocol } from "./link.tsx";
import { MARKDOWN_EXTENSIONS } from "./parser.ts";
import { type LinkTarget, placeholderIndex } from "./preprocess.ts";

/** Writes a block's new markdown; rejects when the write did not land. */
export type SaveMarkdown = (markdown: string) => Promise<void>;

/** Opens a link the block knows better than a URL (a code anchor); false leaves it to the editor. */
export type OpenLink = (href: string, text: string) => boolean;

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; message: string };

/** What the editor's schema reads at render time, kept current across React renders. */
interface Live {
  links: LinkTarget[];
  headingId?: (index: number) => string | undefined;
}

interface Session {
  editor: Editor;
  live: Live;
  /** The split source the editor's document came from; `restoreEditable` resolves against it. */
  prepared: EditableSource;
  /** The block markdown the editor's document matches. */
  synced: string;
  /** The user changed the document since the last save. */
  dirty: boolean;
}

/**
 * A markdown block as a live TipTap editor, saved on blur. The leading h1 stays header chrome
 * and footnotes render read-only below. While the user has unsaved edits, a newer `source` from
 * the agent is not applied: the user's save wins. With `save` null (a past version) it is
 * read-only. Links open on ⌘/Ctrl-click; while read-only, on a plain click.
 */
export function EditableMarkdown({
  source,
  save,
  h1,
  headingId,
  renderLink,
  openLink,
}: {
  source: string;
  save: SaveMarkdown | null;
  h1?: ComponentType<{ children?: ReactNode }>;
  headingId?: (index: number) => string | undefined;
  renderLink?: LinkRenderer;
  openLink?: OpenLink;
}): ReactElement {
  const mount = useRef<HTMLDivElement>(null);
  const session = useRef<Session | null>(null);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [retries, setRetries] = useState(0);
  // Title and footnotes are not edited here; they render from the current source.
  const shown = useMemo(() => prepareEditable(source), [source]);

  const flush = useEffectEvent(async () => {
    const current = session.current;
    if (!current?.dirty || !save) return;
    current.dirty = false;

    const markdown = restoreEditable(
      current.prepared,
      current.editor.storage.markdown.getMarkdown() as string,
    );
    if (markdown === current.synced) return;
    const previous = current.synced;
    current.synced = markdown;

    setState({ kind: "saving" });
    try {
      await save(markdown);
      setState({ kind: "idle" });
    } catch (error) {
      // Unsaved again: a retry or the next blur writes it, and a newer agent version waits.
      current.dirty = true;
      current.synced = previous;
      setState({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  });

  const click = useEffectEvent((view: EditorView, event: MouseEvent): boolean => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    if (!anchor || !view.dom.contains(anchor)) return false;
    // The DOM href is a placeholder: never let the browser follow it.
    event.preventDefault();
    if (view.editable && !(event.metaKey || event.ctrlKey)) return false;

    const href = anchor.getAttribute("href") ?? "";
    const target = resolve(session.current?.live.links ?? [], href);
    if (target?.kind === "footnote") {
      view.dom
        .closest(".review-canvas-root")
        ?.querySelector(`[id="fn-${target.label.replace(/["\\]/g, "\\$&")}"]`)
        ?.scrollIntoView({ block: "start" });
      return true;
    }

    const url = target?.url ?? href;
    if (openLink?.(url, anchor.textContent ?? "")) return true;
    if (["http:", "https:", "mailto:"].includes(urlProtocol(url) ?? "") && !url.startsWith("#"))
      window.open(url, "_blank", "noopener,noreferrer");
    return true;
  });

  useEffect(() => {
    const prepared = prepareEditable(source);
    const live: Live = { links: prepared.body.links, headingId };
    const editor = new Editor({
      element: mount.current!,
      extensions: editorExtensions(live),
      content: prepared.body.markdown,
      editable: save !== null,
      editorProps: {
        attributes: { class: `${PROSE} wb-markdown-editor` },
        handleDOMEvents: { click: (view, event) => click(view, event) },
      },
    });
    editor.on("update", () => {
      if (session.current) session.current.dirty = true;
    });
    editor.on("blur", () => void flush());
    session.current = { editor, live, prepared, synced: source, dirty: false };

    return () => {
      void flush();
      editor.destroy();
      session.current = null;
    };
    // The editor lives as long as the block; later props reach it through the effects below.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A newer version from the agent replaces the document unless the user has unsaved edits.
  useEffect(() => {
    const current = session.current;
    if (!current || current.dirty || source === current.synced) return;
    current.prepared = prepareEditable(source);
    current.live.links = current.prepared.body.links;
    current.synced = source;
    current.editor.commands.setContent(current.prepared.body.markdown, false);
  }, [source]);

  useEffect(() => {
    session.current?.editor.setEditable(save !== null, false);
  }, [save]);

  useEffect(() => {
    if (retries > 0) void flush();
  }, [retries]);

  // Heading ids can change with other blocks; redraw the decorations that carry them.
  useEffect(() => {
    const current = session.current;
    if (!current) return;
    current.live.headingId = headingId;
    current.editor.view.dispatch(current.editor.state.tr.setMeta("addToHistory", false));
  }, [headingId]);

  return (
    <>
      {shown.title && <MarkdownContent source={shown.title} h1={h1} renderLink={renderLink} />}
      <div
        ref={mount}
        className="wb-markdown-editor-mount"
        data-save-state={state.kind}
        data-review-copy-prose
      />
      {state.kind === "failed" && (
        <p role="alert" className="wb-markdown-save-error">
          Couldn't save this edit: {state.message}{" "}
          <button type="button" onClick={() => setRetries((count) => count + 1)}>
            Retry
          </button>
        </p>
      )}
      {shown.body.footnotes.length > 0 && (
        <div className={PROSE}>
          <Footnotes footnotes={shown.body.footnotes} allowRemoteImages renderLink={renderLink} />
        </div>
      )}
    </>
  );
}

function resolve(links: LinkTarget[], href: unknown): LinkTarget | undefined {
  const index = placeholderIndex(href);
  return index === undefined ? undefined : links[index];
}

/**
 * The read path's extensions with four editor deltas:
 *
 * 1. Links and images resolve their placeholder through `live`. An image fetches only an
 *    `https:` URL, as the read path allows, and stays inline in its paragraph.
 * 2. Links do not autolink, so text typed after one does not extend it.
 * 3. Tables do not resize: Markdown cannot keep a width.
 * 4. Root h2/h3 carry the document's heading ids, for the table of contents.
 */
function editorExtensions(live: Live): AnyExtension[] {
  const image = Image.extend({
    renderHTML({ HTMLAttributes }) {
      const resolved = resolve(live.links, HTMLAttributes.src);
      const target = resolved?.kind === "link" ? resolved : undefined;
      const src = target?.url ?? String(HTMLAttributes.src ?? "");
      return [
        "img",
        mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
          src: urlProtocol(src) === "https:" ? src : null,
          title: target?.title ?? HTMLAttributes.title,
        }),
      ];
    },
    // Inline, so saving does not split an image out of its paragraph.
  }).configure({ inline: true, allowBase64: false });

  const link = Link.extend({
    renderHTML({ HTMLAttributes }) {
      const target = resolve(live.links, HTMLAttributes.href);
      // A footnote reference reads as a superscript, as the read path's `<sup>` does.
      const marker =
        target?.kind === "footnote"
          ? { "data-footnote-ref": "" }
          : { title: target?.url ?? HTMLAttributes.href };
      return ["a", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, marker), 0];
    },
  }).configure({
    openOnClick: false,
    // Autolink makes the mark inclusive: text typed after a footnote reference would join it.
    autolink: false,
    HTMLAttributes: { target: null, rel: null },
  });

  const headingIds = Extension.create({
    name: "whiteboardHeadingIds",
    addProseMirrorPlugins: () => [
      new Plugin({
        props: {
          decorations(state) {
            const id = live.headingId;
            if (!id) return null;
            const decorations: Decoration[] = [];
            let index = 0;
            state.doc.forEach((node, offset) => {
              const level = node.type.name === "heading" ? (node.attrs.level as number) : 0;
              if (level !== 2 && level !== 3) return;
              const value = id(index++);
              if (value)
                decorations.push(Decoration.node(offset, offset + node.nodeSize, { id: value }));
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ],
  });

  const replaced: Record<string, AnyExtension> = {
    image,
    link,
    table: Table.configure({ resizable: false }),
  };
  return [
    ...MARKDOWN_EXTENSIONS.map((extension) => replaced[extension.name] ?? extension),
    headingIds,
  ];
}
