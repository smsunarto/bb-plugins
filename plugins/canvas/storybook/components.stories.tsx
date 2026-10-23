import { ready } from "../../../.storybook/ready";
import type { JsonValue } from "../src/shared/document";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { componentTable } from "../src/app/components";
import type { CanvasComponentProps } from "../src/app/components";
import { CanvasProvider, CanvasStateProvider } from "../src/app/state";
import "../src/app/app.css";
const body = () => <p>Component content remains readable while the panel is resized.</p>;
function Component({
  name,
  props,
}: {
  name: keyof typeof componentTable;
  props: CanvasComponentProps["props"];
}) {
  const Render = componentTable[name];
  return (
    <CanvasProvider
      source={{ kind: "workspace", environmentId: "env_story", path: "demo.canvas.mdx" }}
      path="demo.canvas.mdx"
    >
      <CanvasStateProvider>
        <Render props={props} nodes={[]} renderNodes={body} />
      </CanvasStateProvider>
    </CanvasProvider>
  );
}
const meta = {
  play: ready,
  title: "Plugins/Canvas/Components",
  component: Component,
  args: { name: "Card", props: { title: "Review summary" } },
  parameters: {
    host: {
      pluginId: "canvas",
      rpc: {
        state: () => ({ revision: 0, values: {} }),
        setState: (input: { key: string; value: JsonValue }) => ({
          revision: 1,
          values: { [input.key]: input.value },
        }),
      },
    },
  },
} satisfies Meta<typeof Component>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Card: Story = {};
export const Collapsed: Story = {
  args: { props: { title: "Review summary", collapsible: true, defaultOpen: false } },
};
export const Section: Story = { args: { name: "Section", props: { title: "Implementation" } } };
export const Callout: Story = {
  args: { name: "Callout", props: { title: "Attention", tone: "warning" } },
};
export const Statistic: Story = {
  args: {
    name: "Stat",
    props: {
      label: "Completed reviews",
      value: 24,
      delta: "+8",
      tone: "success",
      caption: "This week",
    },
  },
};
export const Pill: Story = { args: { name: "Pill", props: { label: "Ready", tone: "success" } } };
export const Table: Story = {
  args: {
    name: "Table",
    props: {
      headers: ["Plugin", "State"],
      rows: [
        ["Canvas", "Ready"],
        ["Docs", "Cached"],
      ],
      striped: true,
    },
  },
};
export const Toggle: Story = {
  args: { name: "Toggle", props: { id: "details", label: "Show details", default: true } },
};
export const Select: Story = {
  args: {
    name: "Select",
    props: { id: "view", label: "Layout", options: ["List", "Board"], default: "List" },
  },
};
export const Checklist: Story = {
  args: {
    name: "Checklist",
    props: {
      id: "checks",
      items: [
        { id: "a", label: "Inspect source" },
        { id: "b", label: "Verify browser" },
      ],
    },
  },
};
export const Todos: Story = {
  args: {
    name: "Todos",
    props: {
      items: [
        { id: "a", label: "Inspect source", status: "completed" },
        { id: "b", label: "Verify browser", status: "in_progress" },
        { id: "c", label: "Publish", status: "pending" },
      ],
    },
  },
};
