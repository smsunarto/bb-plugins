import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { CompactButton } from "../src/button";

const variants = ["default", "outline", "ghost", "destructive"] as const;
const sizes = ["xs", "sm", "default"] as const;

const meta = {
  title: "Shared/CompactButton",
  component: CompactButton,
  args: { children: "Close", onClick: fn() },
  argTypes: {
    variant: { control: "select", options: variants },
    size: { control: "select", options: sizes },
  },
  tags: ["autodocs"],
} satisfies Meta<typeof CompactButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };
export const VariantMatrix: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <table className="border-separate border-spacing-4">
      <thead>
        <tr>
          <th scope="col">Variant</th>
          {sizes.map((size) => (
            <th key={size} scope="col">
              {size}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {variants.map((variant) => (
          <tr key={variant}>
            <th scope="row">{variant}</th>
            {sizes.map((size) => (
              <td key={size}>
                <CompactButton variant={variant} size={size}>
                  Close
                </CompactButton>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
};

export const DefaultType: Story = {
  name: "(Test) Non-submitting type",
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button")).toHaveAttribute("type", "button");
  },
};
