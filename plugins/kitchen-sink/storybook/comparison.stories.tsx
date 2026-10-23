import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SmartImageCompareDirective } from "../src/app/smart-image-compare";
import { DevinIcon } from "../src/app/devin-branding";
import before from "./before.svg?url";
import after from "./after.svg?url";
const meta = {
  play: ready,
  title: "Components/Kitchen Sink/Image comparison",
  component: SmartImageCompareDirective,
  tags: ["autodocs"],
  args: {
    attributes: {
      before: new URL(before, window.location.origin).href,
      after: new URL(after, window.location.origin).href,
      beforeLabel: "Original",
      afterLabel: "Revised",
    },
    source: "::smart-image-compare",
    message: { id: "msg_story", threadId: "thr_story", turnId: null, projectId: "proj_story" },
    openWorkspaceFile: null,
  },
} satisfies Meta<typeof SmartImageCompareDirective>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Comparison: Story = {};
export const Annotated: Story = {
  args: {
    attributes: {
      ...meta.args.attributes,
      annotations: JSON.stringify([
        { x: 50, y: 50, label: "Changed card emphasis", side: "after" },
      ]),
    },
  },
};
export const InvalidPath: Story = {
  args: { attributes: { before: "../private.png", after: "../private.png" } },
};
export const Branding: Story = {
  render: () => (
    <div className="sb-gallery">
      <DevinIcon className="size-8" />
      <DevinIcon className="size-16" />
    </div>
  ),
};
