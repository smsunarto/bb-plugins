import "./app.css";
import { useEffect } from "react";
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { mountLinkHints, setWindowedThreadOpener } from "./link-hints.ts";

/** Opens a windowed-out sidebar row, which has no link to click, through bb's own navigation. */
function ThreadNavigationBridge() {
  const navigate = useBbNavigate();
  useEffect(() => {
    setWindowedThreadOpener((threadId) => navigate.toThread(threadId));
    return () => setWindowedThreadOpener(null);
  }, [navigate]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "thread-navigation", component: ThreadNavigationBridge });
  app.contentScripts.register({
    id: "link-hints",
    mount: mountLinkHints,
  });
});
