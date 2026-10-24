import { previewSurfaceClass } from "./surfaces";
import { assertMonokai } from "./theme-checks";
import type { Preview } from "@storybook/react-vite";
import { registerCustomTheme } from "@pierre/diffs";
import { monokaiCodeTheme, monokaiStorybookTheme } from "./monokai";
import { editorContextFor, showsEditor } from "./editor-context";
import { EditorFrame } from "./editor-frame";
import { HostFixture } from "./host";
import "./preview.css";
import "../plugins/monokai/.storybook/preview.css";
import "../plugins/monokai/themes/bb-monokai.css";

// Dialogs and popovers portal to body, outside the story's layout wrapper.
document.documentElement.classList.add("dark");
registerCustomTheme(monokaiCodeTheme.name, () => monokaiCodeTheme.theme);

// Non-inline Docs examples are story-mode iframes nested inside the Docs preview.
function isDocsIframe(): boolean {
  try {
    return (
      window.parent !== window &&
      new URL(window.parent.location.href).searchParams.get("viewMode") === "docs"
    );
  } catch {
    return false;
  }
}

const preview: Preview = {
  afterEach: assertMonokai,
  initialGlobals: { width: "wide", context: "auto" },
  globalTypes: {
    context: {
      description: "Preview surroundings",
      toolbar: {
        icon: "browser",
        items: [
          { value: "auto", title: "BB editor · isolated in Docs" },
          { value: "editor", title: "BB editor" },
          { value: "isolated", title: "Isolated component" },
        ],
      },
    },
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
      const placement =
        context.parameters.editorContext === false
          ? undefined
          : (context.parameters.editorContext ?? editorContextFor(context.title));
      const editor =
        placement && showsEditor(context.globals.context, context.viewMode, isDocsIframe());
      const content = scope ? (
        <div className={`sb-surface ${scope}`}>
          <Story />
        </div>
      ) : (
        <Story />
      );
      return (
        <main
          className="dark sb-workspace"
          data-width={context.globals.width}
          data-editor={editor ? "true" : undefined}
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
            {editor ? (
              <EditorFrame context={placement} width={context.globals.width}>
                {content}
              </EditorFrame>
            ) : (
              content
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
