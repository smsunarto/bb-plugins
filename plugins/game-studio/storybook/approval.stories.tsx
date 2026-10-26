import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { GenerationApproval } from "../src/app/generation-approval";
import "../src/app/studio.css";

const interaction = {
  id: "int-1",
  threadId: "thread",
  title: "Approve 2 generations for Compass Courier",
  createdAt: 1,
  expiresAt: null,
  payload: {
    gameId: "courier",
    gameName: "Compass Courier",
    boardId: "main",
    items: [
      {
        requestId: "concept-request",
        nodeId: "concept",
        title: "Character concept",
        kind: "image",
        provider: "google",
        model: "gemini-nano-banana-2.1",
        count: 1,
        retries: 0,
      },
      {
        requestId: "mesh-request",
        nodeId: "mesh",
        title: "Game-ready mesh",
        kind: "model-3d",
        provider: "tripo",
        model: "tripo-p2",
        count: 1,
        retries: 1,
      },
    ],
  },
};
const meta = {
  title: "Components/Game Studio/Generation approval",
  component: GenerationApproval,
  tags: ["autodocs"],
  args: { interaction, submit: fn(async () => {}), cancel: fn(async () => {}) },
  decorators: [
    (Story) => (
      <div className="gs-app" style={{ maxWidth: 420 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GenerationApproval>;
export default meta;
type Story = StoryObj<typeof meta>;

/* Approving once covers the run: the concept, the mesh, and the retry its review may add. */
export const Approve: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Up to 3 generations")).toBeVisible();
    await expect(canvas.getByText("Tripo P2 · up to 1 retry")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(args.submit).toHaveBeenCalledWith({ approved: true }));
  },
};
export const ApproveTheGame: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("checkbox"));
    await userEvent.click(canvas.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(args.submit).toHaveBeenCalledWith({ approved: true, grantGame: true }),
    );
  },
};
export const Decline: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(args.submit).toHaveBeenCalledWith({ approved: false }));
  },
};
export const Unreadable: Story = {
  args: { interaction: { ...interaction, payload: { nope: true } } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("This generation request could not be read."),
    ).toBeVisible();
  },
};
