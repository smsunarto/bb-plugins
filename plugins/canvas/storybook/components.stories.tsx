import { ready } from "../../../.storybook/ready";
import type { JsonValue } from "../src/shared/document";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { componentTable } from "../src/app/components";
import type { CanvasComponentProps } from "../src/app/components";
import { CanvasProvider, CanvasStateProvider } from "../src/app/state";
import "../src/app/app.css";
const body = () => (
  <p>
    The release candidate is ready for desktop review. Reconnection and keyboard-access checks are
    still pending before the rollout.
  </p>
);
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
      source={{
        kind: "workspace",
        environmentId: "env_story",
        path: "release-readiness.canvas.mdx",
      }}
      path="release-readiness.canvas.mdx"
    >
      <CanvasStateProvider>
        <Render props={props} nodes={[]} renderNodes={body} />
      </CanvasStateProvider>
    </CanvasProvider>
  );
}
const meta = {
  play: ready,
  title: "Components/Canvas/Components",
  component: Component,
  args: { name: "Card", props: { title: "Autumn release readiness" } },
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
  args: { props: { title: "Autumn release readiness", collapsible: true, defaultOpen: false } },
};
export const Section: Story = { args: { name: "Section", props: { title: "Rollout checks" } } };
export const Callout: Story = {
  args: {
    name: "Callout",
    props: { title: "Staging database migration required", tone: "warning" },
  },
};
export const Statistic: Story = {
  args: {
    name: "Stat",
    props: {
      label: "Release checks passed",
      value: 18,
      delta: "+4 since yesterday",
      tone: "success",
      caption: "18 of 22 checks complete",
    },
  },
};
export const Pill: Story = { args: { name: "Pill", props: { label: "Ready", tone: "success" } } };
export const Table: Story = {
  args: {
    name: "Table",
    props: {
      headers: ["Service", "Owner", "Release status"],
      rows: [
        ["Web client", "Maya", "Ready"],
        ["API", "Alex", "Migration pending"],
        ["Background workers", "Sam", "Soak test running"],
        ["Documentation", "Nora", "Ready"],
      ],
      striped: true,
    },
  },
};
export const Toggle: Story = {
  args: {
    name: "Toggle",
    props: { id: "details", label: "Include completed checks", default: true },
  },
};
export const Select: Story = {
  args: {
    name: "Select",
    props: {
      id: "view",
      label: "Environment",
      options: ["Staging", "Production"],
      default: "Staging",
    },
  },
};
export const Checklist: Story = {
  args: {
    name: "Checklist",
    props: {
      id: "checks",
      items: [
        { id: "a", label: "Verify migration rollback on staging" },
        { id: "b", label: "Test reconnect with an unsent comment" },
      ],
    },
  },
};
export const Todos: Story = {
  args: {
    name: "Todos",
    props: {
      items: [
        { id: "a", label: "Verify migration rollback on staging", status: "completed" },
        { id: "b", label: "Test reconnect with an unsent comment", status: "in_progress" },
        { id: "c", label: "Approve production rollout", status: "pending" },
      ],
    },
  },
};
