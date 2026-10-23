import { previewSurfaceClass } from "./surfaces";
import { assertMonokai } from "./theme-checks";
import type { Preview } from "@storybook/react-vite";
import { registerCustomTheme } from "@pierre/diffs";
import { monokaiCodeTheme, monokaiStorybookTheme } from "./monokai";
import { HostFixture } from "./host";
import "./preview.css";
import "../plugins/monokai/.storybook/preview.css";
import "../plugins/monokai/themes/bb-monokai.css";

// Dialogs and popovers portal to body, outside the story's layout wrapper.
document.documentElement.classList.add("dark");
registerCustomTheme(monokaiCodeTheme.name, () => monokaiCodeTheme.theme);

const preview: Preview = {
  afterEach: assertMonokai,
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
    (Story, context) => {
      const scope = previewSurfaceClass(context.title);
      return (
        <main
          className="dark sb-workspace"
          data-width={context.globals.width}
          data-layout={context.parameters.previewLayout}
        >
          <HostFixture
            key={context.id}
            storyId={context.id}
            options={context.parameters.host}
            sharedQueryClient={
              context.viewMode !== "docs" || context.parameters.docs?.story?.inline === false
            }
          >
            {scope ? (
              <div className={`sb-surface ${scope}`}>
                <Story />
              </div>
            ) : (
              <Story />
            )}
          </HostFixture>
        </main>
      );
    },
  ],
  parameters: {
    layout: "fullscreen",
    options: {
      storySort: {
        method: "alphabetical",
        order: ["Screens", "Components", ["Theme", "Shared", "*"]],
      },
    },
    docs: {
      theme: monokaiStorybookTheme(),
      story: { inline: true },
      description: {
        component:
          "Production components and complete screens with deterministic local fixtures. BB SDK controls use the official test runtime; no live backend is connected.",
      },
    },
  },
};
export default preview;
