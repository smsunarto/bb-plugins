/// <reference types="vite/client" />
import { screenParameters } from "../../../.storybook/layout";
import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import conceptUrl from "./courier-concept.svg?url&no-inline";
import { StudioCanvas } from "../src/app/canvas";
import type { Board } from "../src/shared/schema";
import "../src/app/studio.css";
import "../src/app/canvas.css";
const board: Board = {
  version: 1,
  id: "story-workflow",
  name: "Compass Courier · character pipeline",
  viewport: { width: 1100, height: 700 },
  nodes: [
    {
      id: "brief",
      type: "text",
      title: "Character brief",
      position: { x: 50, y: 60 },
      data: {
        text: "Compass Courier is a friendly exploration game. The courier crosses mossy ruins carrying letters in a worn leather satchel. Keep the silhouette readable at gameplay distance: oversized hood, short green cape, brass compass, sturdy boots. Use a muted forest-green and warm ochre palette; avoid weapons and fine surface noise.",
      },
    },
    {
      id: "concept",
      type: "image",
      title: "Character concept",
      position: { x: 430, y: 60 },
      data: {
        recipe: "nano-banana",
        prompt:
          "Front-view character sheet for the Compass Courier. Full body, neutral stance, readable hands and boots, forest-green hood and cape, leather letter satchel, brass compass. Soft neutral background and even light. Preserve the practical, friendly silhouette in the art direction.",
        promptSource: { type: "node", nodeId: "brief", port: "text" },
        assetId: "courier-front",
        takes: [{ assetId: "courier-front", jobId: "" }],
      },
    },
    {
      id: "model",
      type: "model-3d",
      title: "Game-ready mesh",
      position: { x: 810, y: 60 },
      data: {
        recipe: "model-3d",
        images: [{ type: "node", nodeId: "concept", port: "front" }],
        targetPolycount: 12000,
      },
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
    documents: [
      {
        id: "art-direction",
        title: "Courier art direction",
        markdown:
          "## Gameplay silhouette\nReadable hood, satchel, and compass at a 12-meter camera distance. Keep hands free for climbing and letter delivery.\n\n## Asset budget\n12,000 triangles before rigging. One 2K material set. Front-view approval before geometry generation.",
        revision: "1",
      },
    ],
    assets: [
      {
        id: "courier-front",
        name: "Courier · approved front view",
        path: new URL(conceptUrl, window.location.origin).pathname.slice(1),
        type: "image",
      },
    ],
    preview: { baseUrl: window.location.origin },
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
    ...screenParameters,
    host: { pluginId: "game-studio", rpc: { briefTemplates: () => ({ templates: [] }) } },
  },
  play: async ({ canvasElement }) => {
    const title = await within(canvasElement).findByText("Character concept");
    await waitFor(() => expect(title).toBeVisible());
    const image = await within(canvasElement).findByAltText<HTMLImageElement>(
      "Courier · approved front view",
    );
    await waitFor(() => expect(image.naturalWidth).toBeGreaterThan(0));
    await waitFor(() =>
      expect(canvasElement.querySelectorAll(".react-flow__edge-path")).toHaveLength(2),
    );
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
          title: "Courier idle · breathing and satchel sway",
          position: { x: 100, y: 60 },
          data: { recipe: "tripo-animate" },
        },
      ],
      edges: [],
    },
  },
  play: async ({ canvasElement }) => {
    const title = await within(canvasElement).findByText(
      "Courier idle · breathing and satchel sway",
    );
    await waitFor(() => expect(title).toBeVisible());
  },
};
