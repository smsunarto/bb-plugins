import { type ReactNode } from "react";
import {
  addExportVisitor$,
  addImportVisitor$,
  addLexicalNode$,
  realmPlugin,
  type LexicalExportVisitor,
  type MdastImportVisitor,
} from "@mdxeditor/editor";
import { experimental_SourceCode as SourceCode } from "@get-bb/plugin-sdk/app";
import {
  $applyNodeReplacement,
  $isElementNode,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
} from "lexical";
import type { MdxjsEsm as Esm } from "mdast-util-mdxjs-esm";
import type { Root } from "mdast";

type SerializedEsm = SerializedLexicalNode & { value: string };

// MDXEditor's default ESM visitor consumes imports/exports without emitting a
// Lexical node. Keep declarations in the document so an unrelated edit cannot
// delete them. Declarations are edited in source mode and are never executed.
class EsmNode extends DecoratorNode<ReactNode> {
  __value: string;

  constructor(value: string, key?: NodeKey) {
    super(key);
    this.__value = value;
  }

  static override getType() {
    return "docs-mdx-esm";
  }
  static override clone(node: EsmNode) {
    return new EsmNode(node.__value, node.__key);
  }
  static override importJSON(node: SerializedEsm) {
    return $applyNodeReplacement(new EsmNode(node.value));
  }
  override exportJSON(): SerializedEsm {
    return { ...super.exportJSON(), type: EsmNode.getType(), version: 1, value: this.__value };
  }
  override createDOM() {
    return document.createElement("div");
  }
  override updateDOM() {
    return false;
  }
  override isInline() {
    return false;
  }
  override decorate() {
    return (
      <div className="docs-mdx-declaration" contentEditable={false}>
        <SourceCode content={this.__value} path={`declaration-${this.getKey()}.tsx`} />
      </div>
    );
  }
}

const importEsm: MdastImportVisitor<Esm> = {
  testNode: "mdxjsEsm",
  priority: 100,
  visitNode({ lexicalParent, mdastNode }) {
    if (!$isElementNode(lexicalParent))
      throw new Error("An MDX declaration must be inside a block");
    lexicalParent.append($applyNodeReplacement(new EsmNode(mdastNode.value)));
  },
};

const preserveImports: MdastImportVisitor<Root> = {
  testNode: "root",
  priority: 100,
  visitNode({ metaData, actions }) {
    // ESM nodes already preserve the original declarations. Do not attach
    // imports to JSX nodes too, which would synthesize duplicate declarations
    // on export (and lose aliases, comments, or unused imports).
    metaData.importDeclarations = {};
    actions.nextVisitor();
  },
};

const exportEsm: LexicalExportVisitor<EsmNode, Esm> = {
  testLexicalNode: (node): node is EsmNode => node instanceof EsmNode,
  visitLexicalNode({ actions, mdastParent, lexicalNode }) {
    actions.appendToParent(mdastParent, { type: "mdxjsEsm", value: lexicalNode.__value });
  },
};

export const preserveEsmPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({
      [addLexicalNode$]: EsmNode,
      [addImportVisitor$]: [preserveImports, importEsm],
      [addExportVisitor$]: exportEsm,
    });
  },
});
