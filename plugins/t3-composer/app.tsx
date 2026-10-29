import {
  definePluginApp,
  experimental_useComposerRenderer as useComposerRenderer,
} from "@get-bb/plugin-sdk/app";
import { PromptBoxInternal } from "./src/PromptBoxInternal";
import "./src/composer.css";
import "./app.css";

function T3Composer() {
  const { input } = useComposerRenderer();
  // Like ChatGPT's, this composer never collapses: drop BB's collapse action and compact form.
  const { onCollapse: _onCollapse, compact: _compact, ...expanded } = input;
  return <PromptBoxInternal {...expanded} />;
}

export default definePluginApp((app) => {
  app.slots.experimental_composer({
    id: "composer",
    title: "T3 Composer",
    description: "T3 Code’s composer layout with BB’s editor and controls.",
    component: T3Composer,
  });
});
