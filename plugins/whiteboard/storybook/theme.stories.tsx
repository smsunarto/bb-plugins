import { File } from "@pierre/diffs/react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within, waitFor } from "storybook/test";
import { Button } from "@bb-plugins/ui/button";
import { AgentMarkdown } from "../src/app/markdown/agent-markdown";
import { CodeThemeProvider } from "../src/app/lib/highlight";
import "../src/app/styles/index.css";
function DocumentControls() {
  return (
    <section className="review-canvas-root light" data-review-theme="light">
      <div className="review-document">
        <Button>Review document</Button>
        <CodeThemeProvider>
          <AgentMarkdown source={'```typescript\nconst theme = "Monokai";\n```'} />
        </CodeThemeProvider>
      </div>
      <File
        file={{ name: "theme.ts", contents: 'const theme = "Monokai";\n' }}
        options={{ theme: "bb-monokai", themeType: "dark" }}
      />
    </section>
  );
}
const meta = {
  title: "Shared/Whiteboard theme contract",
  component: DocumentControls,
  tags: ["autodocs"],
} satisfies Meta<typeof DocumentControls>;
export default meta;
export const Monokai: StoryObj<typeof meta> = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole("button", { name: "Review document" });
    await expect(button).toHaveAttribute("data-slot", "button");
    await expect(getComputedStyle(button).fontFamily).toBe(
      getComputedStyle(canvasElement).getPropertyValue("--font-sans").trim(),
    );
    await waitFor(
      () => expect(canvasElement.querySelector('pre span[style*="color"]')).toBeTruthy(),
      { timeout: 10000 },
    );
  },
};
