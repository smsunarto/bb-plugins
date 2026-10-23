import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { StudioCanvas } from "../src/app/canvas";
import type { Board } from "../src/shared/schema";
import "../src/app/studio.css";
import "../src/app/canvas.css";
const board: Board = {
  version: 1,
  id: "story-workflow",
  name: "Character workflow",
  viewport: { width: 1100, height: 700 },
  nodes: [
    {
      id: "brief",
      type: "text",
      title: "Character brief",
      position: { x: 50, y: 60 },
      data: { text: "A resourceful explorer with a weathered green cloak." },
    },
    {
      id: "concept",
      type: "image",
      title: "Character concept",
      position: { x: 430, y: 60 },
      data: {
        recipe: "nano-banana",
        prompt: "A full-body character concept on a neutral background.",
        promptSource: "brief",
      },
    },
    {
      id: "model",
      type: "model-3d",
      title: "Game-ready mesh",
      position: { x: 810, y: 60 },
      data: { recipe: "tripo-p2", images: ["concept"] },
    },
  ],
  edges: [
    { id: "brief-concept", source: "brief", target: "concept" },
    { id: "concept-model", source: "concept", target: "model" },
  ],
  editorLayout: { version: 1, view: "canvas", nodes: {}, viewport: { x: 20, y: 50, zoom: 0.75 } },
};
function InteractiveCanvas(args: ComponentProps<typeof StudioCanvas>) {
  const [saved, setSaved] = useState({ board: args.board, revision: args.revision });
  return (
    <div style={{ height: 720 }}>
      <StudioCanvas
        {...args}
        {...saved}
        onSave={async (next, expected) => {
          await args.onSave(next, expected);
          const revision = `${Number(saved.revision) + 1}`;
          setSaved({ board: next, revision });
          return { revision };
        }}
      />
    </div>
  );
}
const meta = {
  title: "Screens/Game Studio/Canvas",
  component: StudioCanvas,
  render: (args) => <InteractiveCanvas {...args} />,
  args: {
    gameId: "storybook",
    hostId: "story-host",
    defaultAgent: { providerId: "codex", model: "configured-model", reasoningLevel: "medium" },
    board,
    revision: "1",
    documents: [],
    assets: [],
    onSave: fn(async () => ({ revision: "2" })),
    onGenerate: fn(),
    onGenerateDirect: fn(async () => {}),
    onReview: fn(async () => {}),
    onJudge: fn(async () => {}),
    onGenerationControl: fn(async () => ({ missing: false })),
    onOpenDocument: fn(),
    onUpload: fn(),
  },
  parameters: {
    host: { pluginId: "game-studio", rpc: { briefTemplates: () => ({ templates: [] }) } },
  },
  play: async ({ canvasElement }) => {
    const title = await within(canvasElement).findByText("Character concept");
    await waitFor(() => expect(title).toBeVisible());
  },
} satisfies Meta<typeof StudioCanvas>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Workflow: Story = {};
export const Inspector: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Character concept"));
    await waitFor(() => expect(canvasElement.querySelector(".gs-inspector-title")).toBeVisible());
  },
};
export const Empty: Story = {
  args: { board: { ...board, nodes: [], edges: [] } },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector(".react-flow")).toBeVisible());
    await expect(within(canvasElement).queryByText("Character concept")).not.toBeInTheDocument();
  },
};
export const Inactive: Story = { args: { active: false } };

export const Animation: Story = {
  args: {
    board: {
      ...board,
      nodes: [
        {
          id: "animation",
          type: "animate-3d",
          title: "Animation output",
          position: { x: 100, y: 60 },
          data: { recipe: "tripo-animate" },
        },
      ],
      edges: [],
    },
  },
  play: async ({ canvasElement }) => {
    const title = await within(canvasElement).findByText("Animation output");
    await waitFor(() => expect(title).toBeVisible());
  },
};
