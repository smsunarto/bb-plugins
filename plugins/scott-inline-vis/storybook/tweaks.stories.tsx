import { useState, type ComponentProps } from "react";
import { ready } from "../../../.storybook/ready";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { TweakPanel } from "../tweak-panel";
import "../app.css";
function InteractiveTweaks(args: ComponentProps<typeof TweakPanel>) {
  const [groups, setGroups] = useState(args.groups);
  const [original, setOriginal] = useState(args.original);
  return (
    <TweakPanel
      {...args}
      groups={groups}
      original={original}
      onOriginal={setOriginal}
      onReset={() => setGroups(args.groups)}
      onChange={(groupId, controlId, value) => {
        args.onChange(groupId, controlId, value);
        setGroups((current) =>
          current.map((group) =>
            group.id !== groupId
              ? group
              : {
                  ...group,
                  controls: group.controls.map((control) =>
                    control.id !== controlId
                      ? control
                      : control.type === "slider" && typeof value === "number"
                        ? { ...control, value }
                        : control.type === "toggle" && typeof value === "boolean"
                          ? { ...control, value }
                          : (control.type === "color" || control.type === "select") &&
                              typeof value === "string"
                            ? { ...control, value }
                            : control,
                  ),
                },
          ),
        );
      }}
    />
  );
}
const meta = {
  render: (args) => <InteractiveTweaks {...args} />,
  play: ready,
  title: "Components/Inline Visualizations/Tweak panel",
  component: TweakPanel,
  tags: ["autodocs"],
  args: {
    groups: [
      {
        id: "appearance",
        title: "Appearance",
        visible: true,
        variant: null,
        controls: [
          {
            id: "size",
            type: "slider",
            label: "Size",
            value: 24,
            initialValue: 24,
            min: 12,
            max: 48,
            step: 1,
            unit: "px",
          },
          { id: "grid", type: "toggle", label: "Show grid", value: true, initialValue: true },
          {
            id: "palette",
            type: "select",
            label: "Palette",
            value: "dark",
            initialValue: "dark",
            options: [
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ],
          },
        ],
      },
    ],
    original: false,
    saving: false,
    readOnly: false,
    onChange: fn(),
    onReset: fn(),
    onOriginal: fn(),
    onApply: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof TweakPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Editable: Story = {};
export const Saving: Story = { args: { saving: true } };
export const ReadOnly: Story = { args: { readOnly: true } };
export const Original: Story = { args: { original: true } };
export const Empty: Story = { args: { groups: [] } };
