import { mergeAttributes } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { PromptMentionPillNodeView } from "./PromptMentionPillNodeView";
import { parsePromptEditorMentionAttrs } from "./prompt-editor-serialization";
import { isContextMention } from "../context-mentions";
import {
  experimental_describePromptMention as describePromptMention,
  experimental_promptMentionClipboardAttributes as promptMentionClipboardAttributes,
} from "@get-bb/plugin-sdk/app";

interface MentionRenderArgs {
  node: Pick<ProseMirrorNode, "attrs">;
}

function renderMentionText({ node }: MentionRenderArgs): string {
  const attrs = parsePromptEditorMentionAttrs(node.attrs);
  return attrs?.serializedText ?? "";
}

function isHiddenContextMention(node: ProseMirrorNode | null | undefined, mentionName: string) {
  if (node?.type.name !== mentionName) return false;
  const attrs = parsePromptEditorMentionAttrs(node.attrs);
  return attrs !== null && isContextMention(attrs.mention);
}

/**
 * Where a collapsed cursor lands after stepping over the hidden context
 * mentions beside it, or null when none are there. Annotations and comments are
 * removed through their chip, so Backspace and Delete edit the text past them.
 */
export function positionPastContextMentions(
  state: EditorState,
  direction: "backward" | "forward",
  mentionName: string,
): number | null {
  const { selection } = state;
  if (!selection.empty) return null;
  let pos = selection.from;
  for (;;) {
    const $pos = state.doc.resolve(pos);
    const node = direction === "backward" ? $pos.nodeBefore : $pos.nodeAfter;
    if (!node || !isHiddenContextMention(node, mentionName)) break;
    pos += direction === "backward" ? -node.nodeSize : node.nodeSize;
  }
  return pos === selection.from ? null : pos;
}

export const PromptMentionExtension = Mention.extend({
  addAttributes() {
    const parentAttributes = this.parent?.() ?? {};
    return {
      ...parentAttributes,
      mention: {
        default: null,
      },
      serializedText: {
        default: null,
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(PromptMentionPillNodeView);
  },
  addKeyboardShortcuts() {
    const parent = this.parent?.() ?? {};
    const mentionName = this.name;
    const stepOver =
      (direction: "backward" | "forward", key: "Backspace" | "Delete") =>
      (props: Parameters<NonNullable<(typeof parent)[string]>>[0]) => {
        const { state, view } = props.editor;
        const pos = positionPastContextMentions(state, direction, mentionName);
        if (pos !== null) {
          view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)));
        }
        return parent[key]?.(props) ?? false;
      };
    return {
      ...parent,
      Backspace: stepOver("backward", "Backspace"),
      Delete: stepOver("forward", "Delete"),
    };
  },
  addProseMirrorPlugins() {
    const parentPlugins = this.parent?.() ?? [];
    const mentionName = this.name;
    return [
      ...parentPlugins,
      new Plugin({
        props: {
          decorations(state) {
            const { selection } = state;
            const decorations: Decoration[] = [];
            if (!selection.empty) {
              state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
                if (
                  node.type.name === mentionName &&
                  pos >= selection.from &&
                  pos + node.nodeSize <= selection.to
                ) {
                  decorations.push(
                    Decoration.node(pos, pos + node.nodeSize, {}, { mentionSelected: true }),
                  );
                }
              });
            }

            return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : null;
          },
        },
      }),
    ];
  },
}).configure({
  deleteTriggerWithBackspace: true,
  renderText: renderMentionText,
  renderHTML({ node, options }) {
    const attrs = parsePromptEditorMentionAttrs(node.attrs);
    if (!attrs) {
      return [
        "span",
        mergeAttributes(options.HTMLAttributes, {
          "data-prompt-mention": "true",
          title: "@mention",
        }),
        "@mention",
      ];
    }
    const presentation = describePromptMention(attrs.mention);
    return [
      "span",
      mergeAttributes(options.HTMLAttributes, {
        class: presentation.className,
        ...promptMentionClipboardAttributes(attrs.mention, attrs.serializedText),
        title: presentation.title,
      }),
      presentation.text,
    ];
  },
  suggestion: {
    char: "@",
    items: () => [],
    render: () => ({
      onStart: () => undefined,
      onUpdate: () => undefined,
      onExit: () => undefined,
    }),
  },
});
