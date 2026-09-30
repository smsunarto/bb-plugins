import {
  addExportVisitor$,
  addImportVisitor$,
  addLexicalNode$,
  realmPlugin,
  type LexicalExportVisitor,
  type MdastImportVisitor,
} from "@mdxeditor/editor";
import {
  $applyNodeReplacement,
  $createTextNode,
  TextNode,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
} from "lexical";
import type * as Mdast from "mdast";

/*
 * A soft line break is a newline inside a Markdown paragraph. Renderers show
 * it as a space, so hard-wrapped source reads as one flowing paragraph.
 * MDXEditor keeps the newline in the text, and Lexical's pre-wrap editing
 * surface draws it as a line break. This node owns that difference: it is a
 * space in the editor and a newline in the saved Markdown, so the file's own
 * wrapping survives an edit.
 */
export class SoftBreakNode extends TextNode {
  static override getType(): string {
    return "canvas-soft-break";
  }

  static override clone(node: SoftBreakNode): SoftBreakNode {
    return new SoftBreakNode(node.__key);
  }

  static override importJSON(json: SerializedTextNode): SoftBreakNode {
    return $createSoftBreakNode().updateFromJSON(json);
  }

  constructor(key?: NodeKey) {
    super(" ", key);
  }

  override exportJSON(): SerializedTextNode {
    return { ...super.exportJSON(), type: SoftBreakNode.getType() };
  }
}

export function $createSoftBreakNode(): SoftBreakNode {
  // Token mode keeps typed text out of the break, so it always exports as one newline.
  return $applyNodeReplacement(new SoftBreakNode()).setMode("token");
}

export function $isSoftBreakNode(node: LexicalNode | null | undefined): node is SoftBreakNode {
  return node instanceof SoftBreakNode;
}

const importVisitor: MdastImportVisitor<Mdast.Text> = {
  // Outranks MDXEditor's text visitor, which keeps the newline in the text.
  priority: 1,
  testNode: (node) => node.type === "text" && /\r?\n/.test(node.value),
  visitNode({ mdastNode, lexicalParent, actions }) {
    const format = actions.getParentFormatting();
    const style = actions.getParentStyle();
    mdastNode.value.split(/\r?\n/).forEach((line, index) => {
      const nodes = [
        ...(index > 0 ? [$createSoftBreakNode()] : []),
        ...(line ? [$createTextNode(line)] : []),
      ];
      for (const node of nodes)
        (lexicalParent as ElementNode).append(node.setFormat(format).setStyle(style));
    });
  },
};

function lastText(parent: Mdast.Parent): Mdast.Text | null {
  const last = parent.children.at(-1);
  if (!last) return null;
  if (last.type === "text") return last;
  return "children" in last ? lastText(last) : null;
}

const exportVisitor: LexicalExportVisitor<SoftBreakNode, Mdast.Text> = {
  priority: 1,
  testLexicalNode: $isSoftBreakNode,
  visitLexicalNode({ mdastParent, actions }) {
    // MDXEditor's text visitor applies the break's bold, italic, or other
    // format and appends its space to the text before it. Only that space
    // changes back to the newline.
    actions.nextVisitor();
    const text = lastText(mdastParent);
    if (text?.value.endsWith(" ")) text.value = `${text.value.slice(0, -1)}\n`;
  },
};

export const softBreakPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({
      [addLexicalNode$]: SoftBreakNode,
      [addImportVisitor$]: importVisitor,
      [addExportVisitor$]: exportVisitor,
    });
  },
});
