import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { NeedsYouBanner } from "./banner.tsx";

/** Registers the Needs you banner, and nothing else. */
export default definePluginApp((app) => {
  // Composer banners scope only by composer kind, so this mounts on every
  // thread's composer; it renders only on Captain threads.
  app.composer.customize({
    id: "needs-you",
    scopes: ["thread"],
    banners: [{ id: "needs-you", chrome: "card", component: NeedsYouBanner }],
  });
});
