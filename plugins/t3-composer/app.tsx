import {
  definePluginApp,
  experimental_useComposerRenderer as useComposerRenderer,
} from "@get-bb/plugin-sdk/app";
import { mountBranchPickerStyle } from "./src/branch-picker-style";
import { ComposerHandleProvider } from "./src/composer-handle";
import { PromptBoxInternal } from "./src/PromptBoxInternal";
import { useSettingKeywords } from "./src/composer-settings/useSettingKeywords";
import "./src/composer.css";
import "./app.css";

/** Applies setting keywords typed in the draft; renders nothing. */
function SettingKeywords() {
  useSettingKeywords();
  return null;
}

function T3Composer() {
  const { input } = useComposerRenderer();
  // Like ChatGPT's, this composer never collapses: drop BB's collapse action and compact form.
  const { onCollapse: _onCollapse, compact: _compact, ...expanded } = input;
  return (
    <ComposerHandleProvider>
      <SettingKeywords />
      <PromptBoxInternal {...expanded} />
    </ComposerHandleProvider>
  );
}

export default definePluginApp((app) => {
  // BB's branch picker, styled like the machine selector beside it.
  app.contentScripts.register({
    id: "branch-picker-style",
    mount: ({ signal }) => mountBranchPickerStyle(document, signal),
  });
  app.slots.experimental_composer({
    id: "composer",
    title: "T3 Composer",
    description: "T3 Code’s composer layout with BB’s editor and controls.",
    component: T3Composer,
  });
});
