import { type JsxComponentDescriptor, type JsxEditorProps } from "@mdxeditor/editor";
import { toMarkdown } from "mdast-util-to-markdown";
import { mdxToMarkdown } from "mdast-util-mdx";
import { CanvasWidget, canvasComponentNames } from "@smsunarto/bb-plugin-canvas/editor";

function WidgetEditor({ mdastNode }: JsxEditorProps) {
  return <CanvasWidget markdown={toMarkdown(mdastNode, { extensions: [mdxToMarkdown()] })} />;
}

export const canvasDescriptors: JsxComponentDescriptor[] = canvasComponentNames.map((name) => ({
  name,
  kind: "flow",
  props: [],
  hasChildren: true,
  Editor: WidgetEditor,
}));
