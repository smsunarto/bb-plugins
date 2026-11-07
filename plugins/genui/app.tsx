// bb-plugin-genui frontend. Agents write ```ui and ```app blocks in their
// replies. BB hands those fences to SlotFence through the code-fence renderer slot.
// The `::ui{id="…"}` directive keeps UIs stored by the show_ui pilot rendering.
// The Gen-UI Gallery page renders the example specs in gallery/.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { FENCE_LANGUAGES, SlotFence } from "./ui/SlotFence";
import { GalleryPanel } from "./ui/GalleryPanel";
import { UiDirective } from "./ui/UiDirective";

export default definePluginApp((app) => {
  app.slots.experimental_codeFenceRenderer({ id: "genui", languages: FENCE_LANGUAGES, component: SlotFence });
  app.slots.messageDirective({ id: "ui", component: UiDirective });
  app.slots.navPanel({ id: "gallery", title: "Gen-UI Gallery", icon: "genui/plugin", path: "gallery", component: GalleryPanel });
});
