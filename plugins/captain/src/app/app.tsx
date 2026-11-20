import { definePluginApp, experimental_THREAD_ACTION_GROUPS } from "@get-bb/plugin-sdk/app";
import { ADOPT_ICON, ADOPT_LABEL, AdoptOverlay, adoptItem, useAdoptData } from "./adopt.tsx";
import { NeedsYouBanner } from "./banner.tsx";
import { CrewModelsSettings } from "./settings.tsx";

/**
 * Registers the Needs you banner, the crew model ladders in Captain's settings,
 * and Adopt into Captain in every thread menu.
 */
export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "crew-models",
    title: "Crew models",
    description: "The provider, model and reasoning each crew role starts on, in fallback order.",
    component: CrewModelsSettings,
  });
  // Composer banners scope only by composer kind, so this mounts on every
  // thread's composer; it renders only on Captain threads.
  app.composer.customize({
    id: "needs-you",
    scopes: ["thread"],
    banners: [{ id: "needs-you", chrome: "card", component: NeedsYouBanner }],
  });
  // Every thread menu, the sidebar's right-click menu included: adopt the
  // thread into a Captain's crew. One shared `captains` read decides each row.
  app.slots.experimental_threadAction({
    id: "adopt",
    title: ADOPT_LABEL,
    icon: ADOPT_ICON,
    group: experimental_THREAD_ACTION_GROUPS.organize,
    order: 90,
    useData: useAdoptData,
    item: adoptItem,
  });
  // The dialog that action opens; it outlives the menu and reads nothing until opened.
  app.slots.experimental_appOverlay({ id: "adopt", component: AdoptOverlay });
});
