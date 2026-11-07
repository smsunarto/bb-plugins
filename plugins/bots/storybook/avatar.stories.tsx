import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ready } from "../../../.storybook/ready";
import { AvatarAppearance } from "../components/avatar-appearance";
import { BotIcon } from "../components/bot-icon";
import { AVATAR_SHAPES, type BotAvatar } from "../lib/appearance";
import "../bots.css";

const initial: BotAvatar = {
  color: "#6d5efc",
  shape: "round",
  expression: "curious",
  motion: "calm",
};

/** The avatar picker from the bot editor, with a live preview of each shape. */
function AvatarEditor({ avatar: start }: { avatar: BotAvatar }) {
  const [avatar, setAvatar] = useState(start);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {AVATAR_SHAPES.map((shape, index) => (
          <BotIcon
            key={shape.id}
            avatar={{ ...avatar, shape: shape.id }}
            size={40}
            label={shape.label}
            working={index === 0}
            idleVariant={index}
            selected={shape.id === avatar.shape}
          />
        ))}
      </div>
      <AvatarAppearance avatar={avatar} onChange={setAvatar} />
    </div>
  );
}

const meta = {
  title: "Components/Bots/Avatar",
  component: AvatarEditor,
  tags: ["autodocs"],
  play: ready,
  decorators: [
    (Story) => (
      <div style={{ width: 360, padding: 12 }}>
        <Story />
      </div>
    ),
  ],
  args: { avatar: initial },
} satisfies Meta<typeof AvatarEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A still, focused bot shows the idle pose without motion. */
export const Still: Story = {
  args: { avatar: { color: "#168b75", shape: "squircle", expression: "focused", motion: "still" } },
};
