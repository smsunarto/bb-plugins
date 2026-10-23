import type { Preview } from "@storybook/react-vite";
import { HostFixture } from "./host";
import "./preview.css";
import "../plugins/monokai/.storybook/preview.css";
import "../plugins/monokai/themes/bb-monokai.css";

// Dialogs and popovers portal to body, outside the story's layout wrapper.
document.documentElement.classList.add("dark");

const preview: Preview = {
  initialGlobals: { width: "wide" },
  globalTypes: {
    width: {
      description: "Component container width",
      toolbar: {
        icon: "sidebar",
        items: [
          { value: "narrow", title: "Narrow · 360px" },
          { value: "medium", title: "Panel · 640px" },
          { value: "wide", title: "Wide · 1100px" },
        ],
      },
    },
  },
  decorators: [
    (Story, context) => (
      <main className="dark sb-workspace" data-width={context.globals.width}>
        <HostFixture storyId={context.id} options={context.parameters.host}>
          <Story />
        </HostFixture>
      </main>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    options: { storySort: { order: ["Overview", "Theme", "Plugins", "Shared"] } },
    docs: {
      story: { inline: false },
      description: {
        component:
          "Production plugin components with deterministic local fixtures. BB SDK controls use the official test runtime; no live backend is connected.",
      },
    },
  },
};
export default preview;
