import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, spyOn, userEvent, within } from "storybook/test";
import { Badge, CopyButton, EmptyState, Notice, KeyValue, Mono, Label } from "../src/app/ui";
import "../src/app/cloudflare.css";

const meta = {
  play: ready,
  title: "Components/Cloudflare/Feedback",
  component: Notice,
  tags: ["autodocs"],
  args: {
    children: "Connected to Design MacBook. The Storybook preview on port 6010 is ready to share.",
  },
} satisfies Meta<typeof Notice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Connected: Story = {};
export const Error: Story = {
  args: {
    error: true,
    children:
      "Design MacBook is offline. Saved shares remain visible; reconnect the machine to start or stop a tunnel.",
  },
};
export const Badges: Story = {
  render: () => (
    <div className="sb-gallery">
      {(["neutral", "good", "warn", "bad", "accent"] as const).map((tone) => (
        <Badge key={tone} tone={tone} dot>
          {
            {
              neutral: "Stopped",
              good: "Running",
              warn: "Starting",
              bad: "Connection failed",
              accent: "Public link",
            }[tone]
          }
        </Badge>
      ))}
    </div>
  ),
};
export const Empty: Story = {
  render: () => (
    <EmptyState
      title="No shares yet"
      action={
        <button type="button" className="cf-button" onClick={fn()}>
          New share
        </button>
      }
    >
      Publish a local server to preview your work.
    </EmptyState>
  ),
};
export const Configuration: Story = {
  render: () => (
    <section>
      <Label>Origin</Label>
      <dl>
        <KeyValue label="Local port">
          <Mono>6010</Mono>
        </KeyValue>
        <KeyValue label="Host">Design MacBook · macOS</KeyValue>
      </dl>
    </section>
  ),
};
export const Copy: Story = {
  beforeEach: () => {
    const write = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    return () => write.mockRestore();
  },
  render: () => (
    <CopyButton value="https://atlas-release-review.trycloudflare.com" label="Copy URL" />
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("button"));
    await expect(await c.findByText("Copied to clipboard.")).toBeInTheDocument();
  },
};
