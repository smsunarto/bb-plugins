import "./app.css";
import { useEffect } from "react";
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { CheatsheetPage } from "./cheatsheet-page.tsx";
import { mountLinkHints, setBbNavigation } from "./link-hints.ts";

const CHEATSHEET_PATH = "cheatsheet";

/** Opens destinations that have no link on screen, through bb's own navigation. */
function NavigationBridge() {
  const navigate = useBbNavigate();
  useEffect(() => {
    setBbNavigation({
      openThread: (threadId) => navigate.toThread(threadId),
      // Pressed on the page itself, `?` must not stack a duplicate history entry.
      openCheatsheet: () =>
        navigate.toPluginPanel(CHEATSHEET_PATH, {
          replace: window.location.pathname.endsWith(`/${CHEATSHEET_PATH}`),
        }),
    });
    return () => setBbNavigation(null);
  }, [navigate]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "thread-navigation", component: NavigationBridge });
  app.slots.navPanel({
    id: "cheatsheet",
    title: "Vimium Cheatsheet",
    icon: "Keyboard",
    path: CHEATSHEET_PATH,
    component: CheatsheetPage,
  });
  app.contentScripts.register({
    id: "link-hints",
    mount: mountLinkHints,
  });
});
