import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { NeedsYouBanner } from "./banner.tsx";
import { CaptainIconSettings } from "./icon-settings.tsx";
import { CrewModelsSettings } from "./settings.tsx";

/** Registers the Needs you banner, and the crew model ladders and Captain icons in Captain's settings. */
export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "crew-models",
    title: "Crew models",
    description: "The provider, model and reasoning each crew role starts on, in fallback order.",
    component: CrewModelsSettings,
  });
  app.slots.settingsSection({
    id: "captain-icons",
    title: "Captain icons",
    description: "The icon or picture each Captain shows in the sidebar.",
    component: CaptainIconSettings,
  });
  // Composer banners scope only by composer kind, so this mounts on every
  // thread's composer; it renders only on Captain threads.
  app.composer.customize({
    id: "needs-you",
    scopes: ["thread"],
    banners: [{ id: "needs-you", chrome: "card", component: NeedsYouBanner }],
  });
});
