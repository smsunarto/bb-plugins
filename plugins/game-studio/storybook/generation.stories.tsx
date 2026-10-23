import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ready } from "../../../.storybook/ready";
import { GenerationSettings } from "../src/app/generation";
import { CanvasInputs } from "../src/app/canvas-inputs";
import { BriefStarters } from "../src/app/brief-starters";
import "../src/app/studio.css";
import "../src/app/canvas.css";
const node = {
  id: "image",
  type: "image",
  title: "Character concept",
  position: { x: 0, y: 0 },
  data: { recipe: "nano-banana" },
} as const;
function InteractiveSettings(args: ComponentProps<typeof GenerationSettings>) {
  const [node, setNode] = useState(args.node);
  return (
    <GenerationSettings
      {...args}
      node={node}
      onChange={(patch) => {
        args.onChange(patch);
        setNode((current) => ({ ...current, data: { ...current.data, ...patch } }));
      }}
    />
  );
}
const meta = {
  decorators: [
    (Story) => (
      <div className="gs-app">
        <Story />
      </div>
    ),
  ],
  render: (args) => <InteractiveSettings {...args} />,
  title: "Plugins/Game Studio/Generation controls",
  component: GenerationSettings,
  tags: ["autodocs"],
  play: ready,
  args: { node, onChange: fn() },
} satisfies Meta<typeof GenerationSettings>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Image: Story = {};
export const Video: Story = {
  args: { node: { ...node, id: "video", type: "video", data: { recipe: "omni-video" } } },
};
export const Model: Story = {
  args: { node: { ...node, id: "model", type: "model-3d", data: { recipe: "model-3d" } } },
};
export const Compact: Story = { args: { compact: true } };
export const NoInputs: Story = {
  render: () => <CanvasInputs node={node} nodes={[node]} assets={[]} onToggle={fn()} />,
};
export const MissingReferenceOutput: Story = {
  render: () => (
    <CanvasInputs
      node={node}
      nodes={[node, { ...node, id: "reference", title: "Reference image" }]}
      assets={[]}
      onToggle={fn()}
    />
  ),
};
export const Starters: Story = {
  render: () => <BriefStarters kind="image" hasDraft={false} onInsert={fn()} />,
  parameters: {
    host: {
      pluginId: "game-studio",
      rpc: {
        briefTemplates: () => ({
          templates: [
            {
              id: "character",
              label: "Character sheet",
              text: "Create a front view of [character].",
            },
          ],
        }),
      },
    },
  },
};
