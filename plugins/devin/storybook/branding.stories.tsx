import type { Meta, StoryObj } from "@storybook/react-vite";
import { DevinIcon } from "../src/app/app";

const meta = {
  title: "Components/Devin/Branding",
  component: DevinIcon,
  args: { className: "size-8" },
} satisfies Meta<typeof DevinIcon>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ProviderIcon: Story = {};
