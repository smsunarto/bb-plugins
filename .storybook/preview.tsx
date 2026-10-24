import { addons } from "storybook/preview-api";
import { readPreviewState } from "./preview-state";
import { previewSurfaceClass } from "./surfaces";
import { assertMonokai } from "./theme-checks";
import type { Preview } from "@storybook/react-vite";
import { registerCustomTheme } from "@pierre/diffs";
import { monokaiCodeTheme, monokaiStorybookTheme } from "./monokai";
import { editorContextFor, showsEditor } from "./editor-context";
import { EditorFrame, IsolatedDocument, preloadNativeFrame } from "./editor-frame";
import { HostFixture } from "./host";
import "./preview.css";
import "../plugins/monokai/.storybook/preview.css";
import "../plugins/monokai/themes/bb-monokai.css";

// Dialogs and popovers portal to body, outside the story's layout wrapper.
document.documentElement.classList.add("dark");
registerCustomTheme(monokaiCodeTheme.name, async () => monokaiCodeTheme.theme);

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

let reloadState = readPreviewState();

const preview: Preview = {
  afterEach: assertMonokai,
  loaders: [
    async (context) => {
      if (reloadState?.storyId === context.id) {
        const snapshot = reloadState;
        reloadState = undefined;
        // Restore before render/play, so a later Controls edit cannot race a deferred effect.
        Object.assign(context.args, snapshot.args);
        addons
          .getChannel()
          .emit("updateStoryArgs", { storyId: context.id, updatedArgs: snapshot.args });
      }
      const placement =
        context.parameters.editorContext === false
          ? undefined
          : (context.parameters.editorContext ?? editorContextFor(context.title));
      if (
        placement &&
        __BB_NATIVE_AVAILABLE__ &&
        !__BB_NATIVE_ERROR__ &&
        showsEditor(context.globals.context, context.viewMode, isDocsIframe())
      ) {
        // Let the native module settle before story play functions start.
        // The render boundary presents any import failure with an isolated fallback link.
        await preloadNativeFrame().catch(() => undefined);
      }
      return {};
    },
  ],
  initialGlobals: {
    width: "wide",
    context: import.meta.env.MODE === "test" ? "isolated" : "auto",
    ...reloadState?.globals,
  },
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
      const location = {
        storyId: context.id,
        viewMode: context.viewMode,
        globals: context.globals,
        args: context.args,
        initialArgs: context.initialArgs,
      };
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
              <EditorFrame
                context={placement}
                width={context.globals.width}
                layout={context.parameters.previewLayout}
                location={location}
              >
                {content}
              </EditorFrame>
            ) : (
              <IsolatedDocument location={location}>{content}</IsolatedDocument>
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
