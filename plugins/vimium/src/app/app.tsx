import "./app.css";
import { useEffect } from "react";
import { definePluginApp, experimental_useSidebarThreadActions } from "@get-bb/plugin-sdk/app";
import { mountLinkHints, setWindowedThreadOpener } from "./link-hints.ts";

function ThreadNavigationBridge() {
  const threadActions = experimental_useSidebarThreadActions();
  useEffect(() => {
    setWindowedThreadOpener((threadId) => threadActions.open(threadId));
    return () => setWindowedThreadOpener(null);
  }, [threadActions]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "thread-navigation", component: ThreadNavigationBridge });
  app.contentScripts.register({
    id: "link-hints",
    mount: mountLinkHints,
  });
});
