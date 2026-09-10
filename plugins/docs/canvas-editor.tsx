import { type JsxComponentDescriptor, type JsxEditorProps } from "@mdxeditor/editor";
import { toMarkdown } from "mdast-util-to-markdown";
import { mdxToMarkdown } from "mdast-util-mdx";
import { directiveToMarkdown } from "mdast-util-directive";
import { gfmTableToMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTaskListItemToMarkdown } from "mdast-util-gfm-task-list-item";
import { CanvasWidget, canvasComponentNames } from "@smsunarto/bb-plugin-canvas/editor";

function WidgetEditor({ mdastNode }: JsxEditorProps) {
  // JSX children retain the syntax parsed by the document's editor plugins.
  // Serialize those nodes too, not just the surrounding MDX component.
  return (
    <CanvasWidget
      markdown={toMarkdown(mdastNode, {
        extensions: [
          mdxToMarkdown(),
          directiveToMarkdown(),
          gfmTableToMarkdown(),
          gfmStrikethroughToMarkdown(),
          gfmTaskListItemToMarkdown(),
        ],
      })}
    />
  );
}

export const canvasDescriptors: JsxComponentDescriptor[] = canvasComponentNames.map((name) => ({
  name,
  kind: "flow",
  props: [],
  hasChildren: true,
  Editor: WidgetEditor,
}));
