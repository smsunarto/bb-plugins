import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ChangesTab } from "./changes-tab.tsx";

export default definePluginApp((app) => {
  // The thread's Change. Shown for threads with an environment; the tab
  // reads only while it is the visible tab.
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "changes",
    title: "Changes",
    icon: "GitBranch",
    component: ChangesTab,
    layout: "flush",
    useVisible: ({ environment }) => environment !== null,
  });
});
