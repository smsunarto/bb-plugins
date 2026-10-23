import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within, waitFor } from "storybook/test";
import { Button } from "../src/button";

const variants = ["default", "secondary", "outline", "ghost", "destructive", "link"] as const;
const sizes = ["sm", "default", "lg", "icon"] as const;

const meta = {
  title: "Shared/Button",
  component: Button,
  args: { children: "Continue", onClick: fn() },
  argTypes: {
    variant: {
      control: "select",
      options: variants,
    },
    size: { control: "select", options: sizes },
  },
  tags: ["autodocs"],
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true, children: "Unavailable" } };
export const LongLabel: Story = {
  args: { children: "Review all changes in this checkout before continuing" },
};
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
                <Button
                  variant={variant}
                  size={size}
                  aria-label={size === "icon" ? `${variant} icon` : undefined}
                >
                  {size === "icon" ? "+" : "Continue"}
                </Button>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
};

export const Click: Story = {
  name: "(Test) Click",
  play: async ({ args, canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Continue" }));
    await expect(args.onClick).toHaveBeenCalledOnce();
  },
};
export const ThemedStyles: Story = {
  name: "(Test) Themed styles",
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="sb-gallery">
      <Button>Default</Button>
      <Button variant="ghost" aria-pressed="true">
        Ghost
      </Button>
      <Button variant="destructive">Delete</Button>
      <span data-testid="chrome-type" className="text-2xs">
        Chrome text
      </span>
      <span data-testid="body-type" className="text-base">
        Body text
      </span>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const style = getComputedStyle(canvas.getByRole("button", { name: "Default" }));
    await expect(style.backgroundColor).toBe("rgb(227, 227, 221)");
    await expect(style.color).toBe("rgb(21, 21, 21)");
    await expect(style.height).toBe("36px");
    await expect(style.fontSize).toBe("13px");
    await expect(style.fontWeight).toBe("500");
    await expect(parseFloat(style.lineHeight)).toBeCloseTo((13 * 1.25) / 0.875, 2);
    const chrome = getComputedStyle(canvas.getByTestId("chrome-type"));
    await expect(chrome.fontSize).toBe("10px");
    await expect(chrome.lineHeight).toBe("14px");
    await expect(getComputedStyle(canvas.getByTestId("body-type")).fontSize).toBe("15px");
    await expect(
      getComputedStyle(canvas.getByRole("button", { name: "Delete" })).backgroundColor,
    ).toBe("rgb(227, 70, 113)");
    await waitFor(() =>
      expect(getComputedStyle(canvas.getByRole("button", { name: "Ghost" })).backgroundColor).toBe(
        "rgba(227, 227, 221, 0.2)",
      ),
    );
  },
};
export const IconSizing: Story = {
  name: "(Test) Icon sizing",
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="sb-gallery">
      <Button aria-label="SVG icon">
        <svg data-testid="svg-icon" className="size-3.5" viewBox="0 0 24 24">
          <path d="M4 12h16" />
        </svg>
      </Button>
      <Button aria-label="SDK icon">
        <span data-testid="sdk-icon" data-icon-root="">
          +
        </span>
      </Button>
      <Button
        aria-label="Caller SVG size"
        className="[&_svg]:size-3 max-md:pointer-coarse:[&_svg]:size-5"
      >
        <svg data-testid="caller-svg" viewBox="0 0 24 24">
          <path d="M4 12h16" />
        </svg>
      </Button>
      <Button
        aria-label="Caller SDK size"
        className="[&_[data-icon-root]]:size-3 max-md:pointer-coarse:[&_[data-icon-root]]:size-5"
      >
        <span data-testid="caller-sdk" data-icon-root="">
          +
        </span>
      </Button>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const id of ["svg-icon", "sdk-icon"]) {
      const style = getComputedStyle(canvas.getByTestId(id));
      await expect(style.width).toBe("16px");
      await expect(style.height).toBe("16px");
      await expect(style.pointerEvents).toBe("none");
      await expect(style.flexShrink).toBe("0");
    }
    for (const id of ["caller-svg", "caller-sdk"]) {
      const expected = matchMedia("(width < 48rem) and (pointer: coarse)").matches
        ? "20px"
        : "12px";
      await expect(getComputedStyle(canvas.getByTestId(id)).width).toBe(expected);
    }
  },
};
export const SlottedLink: Story = {
  name: "(Test) Slotted link",
  args: { asChild: true, children: <a href="#button">Link action</a> },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("link")).toHaveAttribute("data-slot", "button");
  },
};
